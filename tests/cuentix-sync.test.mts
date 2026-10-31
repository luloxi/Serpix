import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNTS_SQL, getFinanceTotals, type D1Like } from "../lib/finance.ts";
import {
  MAX_SYNC_BODY_BYTES,
  NONCE_TTL_MS,
  SYNC_MAX_SKEW_MS,
  cuentixAccountId,
  handleCuentixEvent,
  ownerIsSyncable,
  parseSyncEvent,
  signSyncRequest,
  verifySyncSignature,
} from "../lib/cuentix-sync.ts";
import { asUser, call, locked, resetSessionReads, sessionReads, setEnv } from "./route-harness.mts";
import { openDb } from "./db-helper.mts";

const SECRET = "test-secret-not-real";
const OWNER_ID = "owner";
const OWNER_EMAIL = "owner@test.local";
const base = "http://t.local";
const eventsUrl = base + "/api/integrations/cuentix/events";
const vectorPath = fileURLToPath(new URL("../contract/cuentix-sync-vector.json", import.meta.url));
const vectorCopyPath = "/workspace/cuentix-serpix/cuentix-sync-vector.json";

type Tx = {
  id: string;
  user_id: string;
  account_id: string;
  kind: string;
  amount_minor: number;
  category: string;
  description: string | null;
  occurred_at: string;
  source: string | null;
  source_id: string | null;
  source_version: number | null;
  deleted_at: number | null;
  excluded_from_totals: number;
  linked_to: string | null;
  link_suppressed: string | null;
};

type Vector = { secret: string; timestamp: string; nonce: string; body: string; signature: string };

const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as Vector;

function count(db: ReturnType<typeof openDb>["db"], sql: string) {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

function txs(db: ReturnType<typeof openDb>["db"]): Tx[] {
  return db.prepare("SELECT id, user_id, account_id, kind, amount_minor, category, description, occurred_at, source, source_id, source_version, deleted_at, excluded_from_totals, linked_to, link_suppressed FROM financial_transactions ORDER BY created_at, id").all() as Tx[];
}

function accounts(db: ReturnType<typeof openDb>["db"]) {
  return db.prepare("SELECT id, user_id, name, currency FROM financial_accounts ORDER BY id").all() as Array<{ id: string; user_id: string; name: string; currency: string }>;
}

function person(db: ReturnType<typeof openDb>["db"], id: string, role: "admin" | "user", approval: "approved" | "pending" | "rejected", email = id + "@test.local") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, approval);
}

function caja(db: ReturnType<typeof openDb>["db"], id: string, userId: string, currency = "ARS") {
  db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,0,?,?)").run(id, userId, id, currency, 1, 1);
}

function setup(role: "admin" | "user" = "admin", approval: "approved" | "pending" | "rejected" = "approved", email = OWNER_EMAIL) {
  const opened = openDb();
  person(opened.db, OWNER_ID, role, approval, email);
  return opened;
}

function bindEnv(d1: unknown, opts: { email?: string; secret?: string | null } = {}) {
  const extra: Record<string, unknown> = { CUENTIX_SYNC_OWNER_EMAIL: opts.email ?? OWNER_EMAIL };
  if (opts.secret !== null) extra.CUENTIX_SYNC_SECRET = opts.secret ?? SECRET;
  setEnv(d1, extra);
}

function movement(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    event_id: crypto.randomUUID(),
    type: "upsert",
    source: "cuentix",
    source_id: "src-1",
    version: 1,
    occurred_at: "2026-10-01",
    kind: "expense",
    amount_minor: 5000,
    currency: "ARS",
    description: "Cafe",
    category: "Insumos",
    ...over,
  };
}

async function eventsRoute() {
  return import("../app/api/integrations/cuentix/events/route.ts");
}

async function postEvent(raw: string, opts: { ts?: number; nonce?: string; secret?: string; signature?: string | null; omit?: Array<"timestamp" | "nonce" | "signature"> } = {}) {
  const route = await eventsRoute();
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const secret = opts.secret ?? SECRET;
  const signature = opts.signature === undefined ? await signSyncRequest(secret, ts, nonce, raw) : opts.signature;
  const headers: Record<string, string> = {};
  if (!opts.omit?.includes("timestamp")) headers["x-sync-timestamp"] = ts;
  if (!opts.omit?.includes("nonce")) headers["x-sync-nonce"] = nonce;
  if (!opts.omit?.includes("signature") && signature != null) headers["x-sync-signature"] = signature;
  const res = await call(route, "POST", eventsUrl, { text: raw, headers });
  return { ...res, nonce, ts };
}

test("contract vector matches node crypto and Web Crypto", async () => {
  const local = readFileSync(vectorPath);
  const copy = readFileSync(vectorCopyPath);
  assert.deepEqual(local, copy);
  const mac = createHmac("sha256", vector.secret).update(`${vector.timestamp}.${vector.nonce}.${vector.body}`).digest("hex");
  assert.equal("v1=" + mac, vector.signature);
  assert.equal(await signSyncRequest(vector.secret, vector.timestamp, vector.nonce, vector.body), vector.signature);
  assert.equal(await verifySyncSignature(vector.secret, vector.timestamp, vector.nonce, vector.body, vector.signature), true);
  assert.equal(await verifySyncSignature(vector.secret, vector.timestamp, vector.nonce, vector.body + " ", vector.signature), false);
  assert.equal(await verifySyncSignature(vector.secret, vector.timestamp, vector.nonce, vector.body, vector.signature.toUpperCase()), false);
});

test("the vector creates the movement when the timestamp is fresh, and the route rejects it when it is old", async () => {
  const { db, d1 } = setup();
  const applied = await handleCuentixEvent(d1, {
    secret: vector.secret,
    ownerEmail: OWNER_EMAIL,
    rawBody: vector.body,
    timestamp: vector.timestamp,
    nonce: vector.nonce,
    signature: vector.signature,
    now: Number(vector.timestamp),
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body, { ok: true, applied: true });
  const row = txs(db)[0];
  assert.equal(row.user_id, OWNER_ID);
  assert.equal(row.source, "cuentix");
  assert.equal(row.source_id, "vector-tx-1");
  assert.equal(row.source_version, 1700000000000);
  assert.equal(row.amount_minor, 12345);
  assert.equal(row.kind, "expense");
  assert.equal(row.occurred_at, "2023-11-14");
  assert.equal(row.category, "Insumos");
  assert.equal(row.description, "Cafe con leche");
  assert.equal(row.deleted_at, null);
  assert.equal(row.excluded_from_totals, 0);
  const account = accounts(db).find((item) => item.id === cuentixAccountId(OWNER_ID, "ARS"));
  assert.equal(account?.name, "Cuentix (ARS)");
  assert.equal(account?.currency, "ARS");

  const { db: liveDb, d1: live } = setup();
  await locked(async () => {
    bindEnv(live, { email: OWNER_EMAIL, secret: vector.secret });
    asUser("guest");
    resetSessionReads();
    const res = await postEvent(vector.body, { ts: Number(vector.timestamp), nonce: vector.nonce, secret: vector.secret, signature: vector.signature });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
    assert.equal(sessionReads(), 0);
  });
  assert.equal(count(liveDb, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
  assert.equal(count(liveDb, "SELECT COUNT(*) AS n FROM integration_nonces"), 0);
});

test("a valid signature creates one row and ignores the session", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement());
  await locked(async () => {
    bindEnv(d1);
    asUser("someone-else", "user", "approved");
    resetSessionReads();
    const res = await postEvent(raw);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, applied: true });
    assert.equal(sessionReads(), 0);
  });
  assert.equal(txs(db).length, 1);
  assert.equal(txs(db)[0].user_id, OWNER_ID);
  assert.equal(txs(db)[0].amount_minor, 5000);
  const totals = await getFinanceTotals(d1, OWNER_ID);
  assert.equal(totals.ARS.expenseMinor, 5000);
  assert.equal(totals.transactionCount, 1);
});

test("an invalid signature is 401 and writes nothing", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement());
  await locked(async () => {
    bindEnv(d1);
    const res = await postEvent(raw, { signature: "v1=" + "ab".repeat(32) });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_accounts"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 0);
});

test("bad, old and future timestamps are 401 and do not store a nonce", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement({ source_id: "skew-1" }));
  const now = Date.now();
  await locked(async () => {
    bindEnv(d1);
    const route = await eventsRoute();
    for (const ts of ["nope", ""]) {
      const forced = await call(route, "POST", eventsUrl, {
        text: raw,
        headers: {
          "x-sync-timestamp": ts,
          "x-sync-nonce": crypto.randomUUID().replaceAll("-", ""),
          "x-sync-signature": "v1=" + "cd".repeat(32),
        },
      });
      assert.equal(forced.status, 401, "bad timestamp " + JSON.stringify(ts));
      assert.deepEqual(forced.body, { error: "unauthorized" });
    }
    for (const ts of [now - SYNC_MAX_SKEW_MS - 60_000, now + SYNC_MAX_SKEW_MS + 60_000]) {
      const res = await postEvent(raw, { ts });
      assert.equal(res.status, 401, "skew " + ts);
      assert.deepEqual(res.body, { error: "unauthorized" });
    }
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
  const fresh = await handleCuentixEvent(d1, {
    secret: SECRET,
    ownerEmail: OWNER_EMAIL,
    rawBody: raw,
    timestamp: String(now - SYNC_MAX_SKEW_MS),
    nonce: "44".repeat(16),
    signature: await signSyncRequest(SECRET, String(now - SYNC_MAX_SKEW_MS), "44".repeat(16), raw),
    now,
  });
  assert.equal(fresh.status, 200);
  const late = await handleCuentixEvent(d1, {
    secret: SECRET,
    ownerEmail: OWNER_EMAIL,
    rawBody: raw,
    timestamp: String(now - SYNC_MAX_SKEW_MS - 1),
    nonce: "55".repeat(16),
    signature: await signSyncRequest(SECRET, String(now - SYNC_MAX_SKEW_MS - 1), "55".repeat(16), raw),
    now,
  });
  assert.equal(late.status, 401);
  assert.equal(txs(db).length, 1);
});

test("replaying the exact request is 401 and does not create a second row", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement({ source_id: "replay-1" }));
  const ts = Date.now();
  const nonce = "11".repeat(16);
  await locked(async () => {
    bindEnv(d1);
    const first = await postEvent(raw, { ts, nonce });
    assert.equal(first.status, 200);
    const second = await postEvent(raw, { ts, nonce });
    assert.equal(second.status, 401);
    assert.deepEqual(second.body, { error: "unauthorized" });
  });
  assert.equal(txs(db).filter((row) => row.source_id === "replay-1").length, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 1);
});

test("the same source_id with a new nonce stays one row", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement({ source_id: "same-1", version: 4 }));
  await locked(async () => {
    bindEnv(d1);
    assert.equal((await postEvent(raw)).status, 200);
    const again = await postEvent(raw);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, applied: false, reason: "same" });
  });
  assert.equal(txs(db).length, 1);
  assert.equal(txs(db)[0].source_version, 4);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 2);
});

test("a newer upsert edits the row in place", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    assert.equal((await postEvent(JSON.stringify(movement({ source_id: "edit-1", version: 1, amount_minor: 5000, description: "Cafe" })))).status, 200);
    const edited = await postEvent(JSON.stringify(movement({ source_id: "edit-1", version: 2, amount_minor: 9000, description: "Cafe con medialunas", category: "Vianda" })));
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body, { ok: true, applied: true });
  });
  const rows = txs(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_minor, 9000);
  assert.equal(rows[0].description, "Cafe con medialunas");
  assert.equal(rows[0].category, "Vianda");
  assert.equal(rows[0].source_version, 2);
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.expenseMinor, 9000);
});

test("delete soft-deletes the row and the total drops", async () => {
  const { db, d1 } = setup();
  caja(db, "caja", OWNER_ID);
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES ('manual','owner','caja','expense',100,'Cafe','2026-09-01',1)").run();
  await locked(async () => {
    bindEnv(d1);
    assert.equal((await postEvent(JSON.stringify(movement({ source_id: "del-1", version: 3, amount_minor: 5000 })))).status, 200);
    assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.expenseMinor, 5100);
    const removed = await postEvent(JSON.stringify({ v: 1, event_id: crypto.randomUUID(), type: "delete", source: "cuentix", source_id: "del-1", version: 4 }));
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true, applied: true });
  });
  const synced = txs(db).find((row) => row.source_id === "del-1")!;
  assert.ok(synced.deleted_at != null);
  assert.equal(synced.source_version, 4);
  assert.equal(synced.amount_minor, 5000);
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.expenseMinor, 100);
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).transactionCount, 1);
});

test("a stale version is ignored", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    await postEvent(JSON.stringify(movement({ source_id: "stale-1", version: 5, amount_minor: 5000 })));
    const stale = await postEvent(JSON.stringify(movement({ source_id: "stale-1", version: 4, amount_minor: 1 })));
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body, { ok: true, applied: false, reason: "stale" });
  });
  assert.equal(txs(db)[0].amount_minor, 5000);
  assert.equal(txs(db)[0].source_version, 5);
});

test("delete then a stale upsert does not resurrect the row", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    await postEvent(JSON.stringify(movement({ source_id: "tomb-1", version: 2, amount_minor: 5000 })));
    await postEvent(JSON.stringify({ v: 1, event_id: crypto.randomUUID(), type: "delete", source: "cuentix", source_id: "tomb-1", version: 3 }));
    const stale = await postEvent(JSON.stringify(movement({ source_id: "tomb-1", version: 2, amount_minor: 8000 })));
    assert.deepEqual(stale.body, { ok: true, applied: false, reason: "stale" });
  });
  const row = txs(db)[0];
  assert.ok(row.deleted_at != null);
  assert.equal(row.amount_minor, 5000);
  assert.equal(row.source_version, 3);
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).transactionCount, 0);
});

test("a later higher version un-deletes the movement", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    await postEvent(JSON.stringify(movement({ source_id: "back-1", version: 1, amount_minor: 5000 })));
    await postEvent(JSON.stringify({ v: 1, event_id: crypto.randomUUID(), type: "delete", source: "cuentix", source_id: "back-1", version: 2 }));
    const back = await postEvent(JSON.stringify(movement({ source_id: "back-1", version: 3, amount_minor: 7000, kind: "income" })));
    assert.deepEqual(back.body, { ok: true, applied: true });
  });
  const row = txs(db)[0];
  assert.equal(row.deleted_at, null);
  assert.equal(row.amount_minor, 7000);
  assert.equal(row.kind, "income");
  assert.equal(row.source_version, 3);
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.incomeMinor, 7000);
});

test("a delete of an unseen id creates no financial row or account and a stale upsert cannot fill it", async () => {
  const { db, d1 } = setup();
  const accountsBefore = (db.prepare("SELECT COUNT(*) AS n FROM financial_accounts").get() as { n: number }).n;
  await locked(async () => {
    bindEnv(d1);
    const removed = await postEvent(JSON.stringify({ v: 1, event_id: crypto.randomUUID(), type: "delete", source: "cuentix", source_id: "ghost-1", version: 5 }));
    assert.deepEqual(removed.body, { ok: true, applied: false, reason: "unseen" });
    assert.equal(txs(db).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM financial_accounts").get() as { n: number }).n, accountsBefore);
    const stale = await postEvent(JSON.stringify(movement({ source_id: "ghost-1", version: 4, amount_minor: 9999 })));
    assert.deepEqual(stale.body, { ok: true, applied: false, reason: "stale" });
    assert.equal(txs(db).length, 0);
  });
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).transactionCount, 0);
  await locked(async () => {
    bindEnv(d1);
    const live = await postEvent(JSON.stringify(movement({ source_id: "ghost-1", version: 6, amount_minor: 4200, currency: "USD" })));
    assert.deepEqual(live.body, { ok: true, applied: true });
  });
  const revived = txs(db)[0];
  assert.equal(revived.deleted_at, null);
  assert.equal(revived.amount_minor, 4200);
  assert.equal(revived.account_id, cuentixAccountId(OWNER_ID, "USD"));
  assert.equal((await getFinanceTotals(d1, OWNER_ID)).USD.expenseMinor, 4200);
});

test("non-admin, pending and other-user targets are not written", async () => {
  for (const [label, role, approval, email, configured] of [
    ["plain user", "user", "approved", "plain@test.local", "plain@test.local"],
    ["pending admin", "admin", "pending", "pending@test.local", "pending@test.local"],
    ["other admin", "admin", "approved", "real@test.local", "missing@test.local"],
  ] as const) {
    const { db, d1 } = openDb();
    person(db, "who", role, approval, email);
    const raw = JSON.stringify(movement({ source_id: "nope-" + label }));
    await locked(async () => {
      bindEnv(d1, { email: configured });
      const res = await postEvent(raw);
      assert.equal(res.status, 403, label);
      assert.deepEqual(res.body, { error: "forbidden" });
    });
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0, label);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_accounts"), 0, label);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 1, label);
  }
});

test("a missing secret is 401", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1, { secret: null });
    const res = await postEvent(JSON.stringify(movement()), { signature: "v1=" + "ab".repeat(32) });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
});

test("an unsigned request is 401", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    const res = await postEvent("{}", { omit: ["signature"] });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
    const missing = await postEvent("{}", { omit: ["timestamp", "nonce", "signature"] });
    assert.equal(missing.status, 401);
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 0);
});

test("a manual duplicate is counted once, both rows stay flagged, and deleting the manual makes the synced row count", async () => {
  const { db, d1 } = setup();
  caja(db, "caja", OWNER_ID);
  await locked(async () => {
    bindEnv(d1);
    asUser(OWNER_ID, "admin", "approved");
    const list = await import("../app/api/data/[resource]/route.ts");
    const one = await import("../app/api/data/[resource]/[id]/route.ts");
    const created = await call(list, "POST", base + "/api/data/transactions", {
      params: { resource: "transactions" },
      json: { accountId: "caja", amountMinor: 5000, category: "Cafe", kind: "expense", occurredAt: "2026-10-01", description: "Cafe" },
    });
    assert.equal(created.status, 201);
    const manualId = (created.body as { id: string }).id;
    const synced = await postEvent(JSON.stringify(movement({ source_id: "dup-1", amount_minor: 5000, occurred_at: "2026-10-01", kind: "expense", currency: "ARS" })));
    assert.deepEqual(synced.body, { ok: true, applied: true });
    const totals = await getFinanceTotals(d1, OWNER_ID);
    assert.equal(totals.ARS.expenseMinor, 5000);
    assert.equal(totals.transactionCount, 1);
    const listed = await call(list, "GET", base + "/api/data/transactions", { params: { resource: "transactions" } });
    const items = (listed.body as { items: Array<Record<string, unknown>> }).items;
    assert.equal(items.length, 2);
    for (const item of items) assert.equal(typeof item.linkedTo, "string");
    const manual = items.find((item) => item.id === manualId)!;
    const remote = items.find((item) => item.source === "cuentix")!;
    assert.equal(manual.excludedFromTotals, 0);
    assert.equal(remote.excludedFromTotals, 1);
    assert.equal(manual.linkedTo, remote.id);
    assert.equal(remote.linkedTo, manualId);
    const balances = await d1.prepare(ACCOUNTS_SQL).bind(OWNER_ID).all<{ id: string; balanceMinor: number }>();
    const byId = new Map((balances.results ?? []).map((row) => [row.id, Number(row.balanceMinor)]));
    assert.equal(byId.get("caja"), -5000);
    assert.equal(byId.get(cuentixAccountId(OWNER_ID, "ARS")), 0);
    const removed = await call(one, "DELETE", base + "/api/data/transactions/" + manualId, { params: { resource: "transactions", id: manualId } });
    assert.equal(removed.status, 200);
    const after = await getFinanceTotals(d1, OWNER_ID);
    assert.equal(after.ARS.expenseMinor, 5000);
    assert.equal(after.transactionCount, 1);
    const left = txs(db).find((row) => row.source === "cuentix")!;
    assert.equal(left.excluded_from_totals, 0);
    assert.equal(left.linked_to, null);
    assert.equal(left.deleted_at, null);
  });
});

test("unlink keeps both rows counting and a newer upsert does not link them again", async () => {
  const { db, d1 } = setup();
  caja(db, "caja", OWNER_ID);
  await locked(async () => {
    bindEnv(d1);
    asUser(OWNER_ID, "admin", "approved");
    const list = await import("../app/api/data/[resource]/route.ts");
    const one = await import("../app/api/data/[resource]/[id]/route.ts");
    const created = await call(list, "POST", base + "/api/data/transactions", {
      params: { resource: "transactions" },
      json: { accountId: "caja", amountMinor: 5000, category: "Cafe", kind: "expense", occurredAt: "2026-10-01" },
    });
    const manualId = (created.body as { id: string }).id;
    await postEvent(JSON.stringify(movement({ source_id: "link-1", amount_minor: 5000 })));
    const unlinked = await call(one, "PATCH", base + "/api/data/transactions/" + manualId, {
      params: { resource: "transactions", id: manualId },
      json: { unlink: true },
    });
    assert.equal(unlinked.status, 200);
    assert.deepEqual(unlinked.body, { ok: true, linked: false });
    assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.expenseMinor, 10000);
    assert.equal((await getFinanceTotals(d1, OWNER_ID)).transactionCount, 2);
    const again = await postEvent(JSON.stringify(movement({ source_id: "link-1", version: 2, amount_minor: 5000 })));
    assert.deepEqual(again.body, { ok: true, applied: true });
    assert.equal((await getFinanceTotals(d1, OWNER_ID)).transactionCount, 2);
    assert.equal((await getFinanceTotals(d1, OWNER_ID)).ARS.expenseMinor, 10000);
    for (const row of txs(db)) assert.equal(row.linked_to, null);
  });
});

test("currency, kind and date must all match before two rows link", async () => {
  const { db, d1 } = setup();
  caja(db, "ars", OWNER_ID, "ARS");
  caja(db, "usd", OWNER_ID, "USD");
  await locked(async () => {
    bindEnv(d1);
    asUser(OWNER_ID, "admin", "approved");
    const list = await import("../app/api/data/[resource]/route.ts");
    await call(list, "POST", base + "/api/data/transactions", { params: { resource: "transactions" }, json: { accountId: "usd", amountMinor: 5000, category: "Cafe", kind: "expense", occurredAt: "2026-10-01" } });
    await call(list, "POST", base + "/api/data/transactions", { params: { resource: "transactions" }, json: { accountId: "ars", amountMinor: 5000, category: "Cafe", kind: "income", occurredAt: "2026-10-01" } });
    await call(list, "POST", base + "/api/data/transactions", { params: { resource: "transactions" }, json: { accountId: "ars", amountMinor: 5000, category: "Cafe", kind: "expense", occurredAt: "2026-10-02" } });
    await postEvent(JSON.stringify(movement({ source_id: "miss-1", amount_minor: 5000, currency: "ARS", kind: "expense", occurred_at: "2026-10-01" })));
  });
  assert.equal(txs(db).every((row) => row.linked_to == null), true);
  const totals = await getFinanceTotals(d1, OWNER_ID);
  assert.equal(totals.ARS.expenseMinor, 10000);
  assert.equal(totals.ARS.incomeMinor, 5000);
  assert.equal(totals.USD.expenseMinor, 5000);
  assert.equal(totals.transactionCount, 4);
});

test("a guest cannot see or change the owner's synced movement", async () => {
  const { db, d1 } = setup();
  person(db, "guest", "user", "approved", "guest@test.local");
  caja(db, "guest-caja", "guest");
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES ('guest-tx','guest','guest-caja','expense',100,'Comida','2026-10-02',2)").run();
  await locked(async () => {
    bindEnv(d1);
    asUser("guest", "user", "approved");
    const created = await postEvent(JSON.stringify(movement({ source_id: "guest-hidden", amount_minor: 9999 })));
    assert.deepEqual(created.body, { ok: true, applied: true });
    const list = await import("../app/api/data/[resource]/route.ts");
    const one = await import("../app/api/data/[resource]/[id]/route.ts");
    const totals = await import("../app/api/finance/totals/route.ts");
    const seen = await call(list, "GET", base + "/api/data/transactions", { params: { resource: "transactions" } });
    assert.equal(seen.status, 200);
    const items = (seen.body as { items: Array<Record<string, unknown>> }).items;
    assert.deepEqual(items.map((item) => item.id), ["guest-tx"]);
    const guestTotals = await call(totals, "GET", base + "/api/finance/totals");
    assert.equal((guestTotals.body as { ARS: { expenseMinor: number }; transactionCount: number }).ARS.expenseMinor, 100);
    assert.equal((guestTotals.body as { transactionCount: number }).transactionCount, 1);
    const ownerTx = txs(db).find((row) => row.source === "cuentix")!;
    assert.equal(ownerTx.user_id, OWNER_ID);
    const patched = await call(one, "PATCH", base + "/api/data/transactions/" + ownerTx.id, {
      params: { resource: "transactions", id: ownerTx.id },
      json: { unlink: true },
    });
    assert.equal(patched.status, 404);
    const removed = await call(one, "DELETE", base + "/api/data/transactions/" + ownerTx.id, { params: { resource: "transactions", id: ownerTx.id } });
    assert.equal(removed.status, 404);
    asUser(OWNER_ID, "admin", "approved");
    const ownerList = await call(list, "GET", base + "/api/data/transactions", { params: { resource: "transactions" } });
    const ownerItems = (ownerList.body as { items: Array<Record<string, unknown>> }).items;
    assert.equal(ownerItems.length, 1);
    assert.equal(ownerItems[0].source, "cuentix");
    assert.equal(ownerItems[0].amountMinor, 9999);
  });
  assert.equal(txs(db).find((row) => row.source === "cuentix")?.user_id, OWNER_ID);
});

test("synced amount, date, kind and account are read-only; category still saves; delete is rejected", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    asUser(OWNER_ID, "admin", "approved");
    await postEvent(JSON.stringify(movement({ source_id: "ro-1", amount_minor: 5000, category: "Insumos" })));
    const row = txs(db)[0];
    const one = await import("../app/api/data/[resource]/[id]/route.ts");
    const baseBody = { accountId: row.account_id, amountMinor: 5000, category: "Insumos", kind: "expense", occurredAt: "2026-10-01", description: "Cafe" };
    const amount = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, amountMinor: 100 } });
    assert.equal(amount.status, 400);
    assert.match(JSON.stringify(amount.body), /Cuentix/);
    const kind = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, kind: "income" } });
    assert.equal(kind.status, 400);
    const date = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, occurredAt: "2026-10-02" } });
    assert.equal(date.status, 400);
    caja(db, "otra", OWNER_ID);
    const account = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, accountId: "otra" } });
    assert.equal(account.status, 400);
    const repeat = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, recurrence: "monthly" } });
    assert.equal(repeat.status, 400);
    const category = await call(one, "PATCH", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id }, json: { ...baseBody, category: "Vianda", description: "Nota local" } });
    assert.equal(category.status, 200);
    const removed = await call(one, "DELETE", base + "/api/data/transactions/" + row.id, { params: { resource: "transactions", id: row.id } });
    assert.equal(removed.status, 409);
    assert.match(JSON.stringify(removed.body), /Cuentix/);
  });
  const row = txs(db)[0];
  assert.equal(row.amount_minor, 5000);
  assert.equal(row.category, "Vianda");
  assert.equal(row.description, "Nota local");
  assert.equal(row.deleted_at, null);
});

test("an empty category becomes Cuentix and USD gets its own account", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    const named = await postEvent(JSON.stringify(movement({ source_id: "cat-1", category: "   ", description: "   " })));
    assert.deepEqual(named.body, { ok: true, applied: true });
    const usd = await postEvent(JSON.stringify(movement({ source_id: "usd-1", currency: "USD", amount_minor: 250, category: "Fees" })));
    assert.deepEqual(usd.body, { ok: true, applied: true });
    db.prepare("UPDATE financial_accounts SET name=? WHERE id=?").run("Mi Cuentix", cuentixAccountId(OWNER_ID, "ARS"));
    const again = await postEvent(JSON.stringify(movement({ source_id: "cat-1", version: 2, category: "Insumos", description: "" })));
    assert.deepEqual(again.body, { ok: true, applied: true });
  });
  const ars = txs(db).find((row) => row.source_id === "cat-1")!;
  assert.equal(ars.category, "Insumos");
  assert.equal(ars.description, null);
  const usd = accounts(db).find((row) => row.id === cuentixAccountId(OWNER_ID, "USD"));
  assert.equal(usd?.name, "Cuentix (USD)");
  assert.equal(accounts(db).find((row) => row.id === cuentixAccountId(OWNER_ID, "ARS"))?.name, "Mi Cuentix");
  assert.equal(accounts(db).filter((row) => row.name.startsWith("Cuentix") || row.name === "Mi Cuentix").length, 2);
});

test("rows with source NULL still count, and a deleted synced row does not", async () => {
  const { db, d1 } = setup();
  caja(db, "caja", OWNER_ID);
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES ('old','owner','caja','income',100,'venta','2024-01-01',1)").run();
  await locked(async () => {
    bindEnv(d1);
    await postEvent(JSON.stringify(movement({ source_id: "keep-1", amount_minor: 200, occurred_at: "2026-01-02" })));
    await postEvent(JSON.stringify(movement({ source_id: "gone-1", amount_minor: 300, occurred_at: "2026-01-03", version: 1 })));
    await postEvent(JSON.stringify({ v: 1, event_id: crypto.randomUUID(), type: "delete", source: "cuentix", source_id: "gone-1", version: 2 }));
  });
  const totals = await getFinanceTotals(d1, OWNER_ID);
  assert.equal(totals.ARS.incomeMinor, 100);
  assert.equal(totals.ARS.expenseMinor, 200);
  assert.equal(totals.transactionCount, 2);
  const balances = await d1.prepare(ACCOUNTS_SQL).bind(OWNER_ID).all<{ id: string; balanceMinor: number }>();
  const cajaBalance = (balances.results ?? []).find((row) => row.id === "caja");
  assert.equal(Number(cajaBalance?.balanceMinor), 100);
});

test("nonces older than 15 minutes are purged only after a valid signature", async () => {
  const { db, d1 } = setup();
  const old = "ab".repeat(16);
  const now = Date.now();
  db.prepare("INSERT INTO integration_nonces (source, nonce, ts) VALUES ('cuentix', ?, ?)").run(old, now - NONCE_TTL_MS - 1000);
  await locked(async () => {
    bindEnv(d1);
    const bad = await postEvent(JSON.stringify(movement()), { signature: "v1=" + "11".repeat(32) });
    assert.equal(bad.status, 401);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces WHERE nonce='" + old + "'"), 1);
    const ok = await postEvent(JSON.stringify(movement({ source_id: "purge-1" })));
    assert.equal(ok.status, 200);
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces WHERE nonce='" + old + "'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 1);
});

test("an invalid payload is 400 and that nonce cannot be reused", async () => {
  const { db, d1 } = setup();
  const raw = JSON.stringify(movement({ amount_minor: 10.5 }));
  const nonce = "22".repeat(16);
  const ts = Date.now();
  await locked(async () => {
    bindEnv(d1);
    const bad = await postEvent(raw, { ts, nonce });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: "invalid_payload" });
    const replay = await postEvent(raw, { ts, nonce });
    assert.equal(replay.status, 401);
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 1);
  assert.equal(parseSyncEvent(JSON.stringify(movement({ category: "" }))).ok, true);
  const parsed = parseSyncEvent(JSON.stringify(movement({ category: "" })));
  assert.equal(parsed.ok && parsed.event.type === "upsert" && parsed.event.category, "Cuentix");
});

test("a body over 16KB is 413 and a 16KB invalid body is 400", async () => {
  const { db, d1 } = setup();
  await locked(async () => {
    bindEnv(d1);
    const huge = "x".repeat(MAX_SYNC_BODY_BYTES + 1);
    const tooBig = await postEvent(huge, { signature: "v1=" + "ab".repeat(32) });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(tooBig.body, { error: "too_large" });
    const wide = "á".repeat(9000);
    assert.ok(new TextEncoder().encode(wide).byteLength > MAX_SYNC_BODY_BYTES);
    const wideRes = await postEvent(wide, { signature: "v1=" + "ab".repeat(32) });
    assert.equal(wideRes.status, 413);
    const exact = "x".repeat(MAX_SYNC_BODY_BYTES);
    const edge = await postEvent(exact);
    assert.equal(edge.status, 400);
    assert.deepEqual(edge.body, { error: "invalid_payload" });
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM integration_nonces"), 1);
});

test("owner email match is case-insensitive", async () => {
  const { db, d1 } = setup("admin", "approved", "Owner@test.local");
  await locked(async () => {
    bindEnv(d1, { email: "OWNER@test.local" });
    const res = await postEvent(JSON.stringify(movement({ source_id: "case-1" })));
    assert.deepEqual(res.body, { ok: true, applied: true });
  });
  assert.equal(txs(db)[0].user_id, OWNER_ID);
});

test("ownerIsSyncable allows only an approved admin without the encryption flag", () => {
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved" }), true);
  assert.equal(ownerIsSyncable({ role: "user", approvalStatus: "approved" }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "pending" }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "rejected" }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved", encryptionEnabled: 1 }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved", encryptionEnabled: true }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved", encryptionEnabled: "1" }), false);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved", encryptionEnabled: 0 }), true);
});

test("an encrypted user never receives Cuentix sync, even when role and email match", async () => {
  for (const mode of ["e2e", "something-else"]) {
    const { db, d1 } = setup("admin", "approved");
    db.prepare("UPDATE user SET encryption_mode=? WHERE id=?").run(mode, OWNER_ID);
    const raw = JSON.stringify(movement({ source_id: "enc-" + mode }));
    await locked(async () => {
      bindEnv(d1);
      const res = await postEvent(raw);
      assert.equal(res.status, 403, mode);
      assert.deepEqual(res.body, { error: "forbidden" });
    });
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 0, mode);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_accounts"), 0, mode);
  }
  // control: the same owner in server mode (the default column value) still syncs.
  const { d1, db } = setup("admin", "approved");
  await locked(async () => {
    bindEnv(d1);
    const res = await postEvent(JSON.stringify(movement({ source_id: "enc-control" })));
    assert.equal(res.status, 200);
  });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 1);
  assert.equal(ownerIsSyncable({ role: "admin", approvalStatus: "approved", encryptionEnabled: "e2e" !== "server" }), false);
});

test("a database failure is 500 and the log does not include the secret or the body", async () => {
  const boom: D1Like = { prepare() { throw new Error("db down"); } };
  const raw = JSON.stringify(movement());
  const ts = String(Date.now());
  const nonce = "33".repeat(16);
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const res = await handleCuentixEvent(boom, {
      secret: SECRET,
      ownerEmail: OWNER_EMAIL,
      rawBody: raw,
      timestamp: ts,
      nonce,
      signature: await signSyncRequest(SECRET, ts, nonce, raw),
      now: Number(ts),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "unavailable" });
    assert.deepEqual(errors, [["cuentix_sync_failed"]]);
    assert.equal(JSON.stringify(errors).includes(SECRET), false);
    assert.equal(JSON.stringify(errors).includes("Cafe"), false);
  } finally {
    console.error = orig;
  }
});

test("Finanzas copy marks the origin and the linked duplicate", () => {
  const ui = readFileSync(fileURLToPath(new URL("../app/workspace.tsx", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../app/gastos.css", import.meta.url)), "utf8");
  assert.match(ui, /className="tag cuentix-badge">Cuentix</);
  assert.match(ui, /Vinculado con Cuentix, no suma doble/);
  assert.match(ui, /Este movimiento viene de Cuentix/);
  assert.match(ui, />Desvincular</);
  assert.match(ui, /source==="cuentix"\?undefined: \(\) => void remove\("transactions", t\)|source==="cuentix"\?undefined:\(\)=>void remove\("transactions",t\)/);
  assert.match(ui, /button\.cuentix-link|cuentix-link/);
  assert.match(css, /button\.cuentix-link,\.cuentix-unlink\{cursor:pointer\}/);
  assert.match(ui, /readOnly=\{locked\}/);
  assert.match(ui, /payload\.kind=editor\.item\.kind/);
});
