import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { AI_CUTOFF_NEURONS, AI_DISABLED_MESSAGE, AI_GLOBAL_LIMIT_MESSAGE, INVITEE_RECEIPT_SCANS_PER_DAY, NEURONS_PER_SCAN_ESTIMATE, SCAN_LIMIT_MESSAGE, utcDay } from "../lib/ai-quota.ts";
import { BLOB_TOO_BIG_ERROR, E2E_NOT_ENABLED, ENVELOPE_ERROR, LEGACY_DATA_ERROR, SCAN_AI_WARNING, TOMBSTONE_BLOB } from "../lib/e2e-server.ts";
import { RECEIPT_TOO_BIG_MESSAGE } from "../lib/receipt.ts";
import { todayInBuenosAires } from "../lib/recurring.ts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { openDb, user } from "./db-helper.mts";
import { A, B, assertSame, docBody, entryBody, ids, seedWorld, snap, txBody } from "./isolation-shared.mts";

const base = "http://t.local";
const NONCE = "a".repeat(16);
const CIPHER = "b".repeat(22);
const BLOB = JSON.stringify({ v: 1, n: NONCE, c: CIPHER });
const ENCRYPTED = "Cuenta cifrada: usá el modo cifrado de la app.";

function passwordWrap(m = 65536) {
  return { v: 1, type: "password", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), m, t: 3, p: 1, argonSalt: "r".repeat(22) };
}
function passkeyWrap() {
  return { v: 1, type: "passkey", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), prfSalt: "p".repeat(43) };
}
function png(size = 32) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], "ticket.png", { type: "image/png" });
}
function form(file: File = png()) {
  const body = new FormData();
  body.set("file", file);
  return body;
}
function noStore(headers: Record<string, string>) {
  assert.equal(headers["cache-control"], "no-store");
}
function rows(db: DatabaseSync, sql: string, ...args: Array<string | number>) {
  return db.prepare(sql).all(...args);
}

async function api() {
  return {
    keys: await import("../app/api/e2e/keys/route.ts"),
    key: await import("../app/api/e2e/keys/[id]/route.ts"),
    records: await import("../app/api/e2e/records/route.ts"),
    record: await import("../app/api/e2e/records/[collection]/[id]/route.ts"),
    counter: await import("../app/api/e2e/counter/route.ts"),
    scanAi: await import("../app/api/e2e/scan-ai/route.ts"),
    list: await import("../app/api/data/[resource]/route.ts"),
    one: await import("../app/api/data/[resource]/[id]/route.ts"),
    finance: await import("../app/api/finance/totals/route.ts"),
    docs: await import("../app/api/documents/route.ts"),
    doc: await import("../app/api/documents/[id]/route.ts"),
    hours: await import("../app/api/documents/time-entries/route.ts"),
    entries: await import("../app/api/time-entries/route.ts"),
    entry: await import("../app/api/time-entries/[id]/route.ts"),
    timer: await import("../app/api/timer/route.ts"),
    rules: await import("../app/api/recurring/route.ts"),
    rule: await import("../app/api/recurring/[id]/route.ts"),
    scan: await import("../app/api/receipts/scan/route.ts"),
    receipt: await import("../app/api/receipts/[id]/route.ts"),
    avatar: await import("../app/api/avatar/[id]/route.ts"),
    inquiries: await import("../app/api/inquiries/route.ts"),
    inquiry: await import("../app/api/inquiries/[id]/route.ts"),
    push: await import("../app/api/push/subscribe/route.ts"),
    admin: await import("../app/api/admin/users/route.ts"),
  };
}

type Routes = Awaited<ReturnType<typeof api>>;
type Mod = Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;

function legacyHits(routes: Routes): { name: string; method: string; mod: Mod; url: string; params?: Record<string, string>; json?: unknown; form?: FormData }[] {
  const resources = ["contacts", "projects", "tasks", "accounts", "transactions", "activities"];
  const out: { name: string; method: string; mod: Mod; url: string; params?: Record<string, string>; json?: unknown; form?: FormData }[] = [];
  for (const resource of resources) {
    out.push({ name: "GET data " + resource, method: "GET", mod: routes.list, url: base + "/api/data/" + resource, params: { resource } });
    out.push({ name: "POST data " + resource, method: "POST", mod: routes.list, url: base + "/api/data/" + resource, params: { resource }, json: {} });
    out.push({ name: "PATCH data " + resource, method: "PATCH", mod: routes.one, url: base + "/api/data/" + resource + "/x", params: { resource, id: "x" }, json: {} });
    out.push({ name: "DELETE data " + resource, method: "DELETE", mod: routes.one, url: base + "/api/data/" + resource + "/x", params: { resource, id: "x" } });
  }
  out.push(
    { name: "GET finance", method: "GET", mod: routes.finance, url: base + "/api/finance/totals" },
    { name: "GET documents", method: "GET", mod: routes.docs, url: base + "/api/documents" },
    { name: "POST documents", method: "POST", mod: routes.docs, url: base + "/api/documents", json: {} },
    { name: "GET document", method: "GET", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" } },
    { name: "PATCH document", method: "PATCH", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" }, json: {} },
    { name: "DELETE document", method: "DELETE", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" } },
    { name: "GET document hours", method: "GET", mod: routes.hours, url: base + "/api/documents/time-entries?contactId=x" },
    { name: "GET time-entries", method: "GET", mod: routes.entries, url: base + "/api/time-entries" },
    { name: "POST time-entries", method: "POST", mod: routes.entries, url: base + "/api/time-entries", json: {} },
    { name: "DELETE time-entry", method: "DELETE", mod: routes.entry, url: base + "/api/time-entries/x", params: { id: "x" } },
    { name: "GET timer", method: "GET", mod: routes.timer, url: base + "/api/timer" },
    { name: "POST timer", method: "POST", mod: routes.timer, url: base + "/api/timer", json: {} },
    { name: "GET recurring", method: "GET", mod: routes.rules, url: base + "/api/recurring" },
    { name: "PATCH recurring", method: "PATCH", mod: routes.rule, url: base + "/api/recurring/x", params: { id: "x" }, json: {} },
    { name: "DELETE recurring", method: "DELETE", mod: routes.rule, url: base + "/api/recurring/x", params: { id: "x" } },
    { name: "POST scan", method: "POST", mod: routes.scan, url: base + "/api/receipts/scan" },
    { name: "GET receipt", method: "GET", mod: routes.receipt, url: base + "/api/receipts/x", params: { id: "x" } },
    { name: "DELETE receipt", method: "DELETE", mod: routes.receipt, url: base + "/api/receipts/x", params: { id: "x" } },
    { name: "GET avatar", method: "GET", mod: routes.avatar, url: base + "/api/avatar/x", params: { id: "x" } },
    { name: "POST avatar", method: "POST", mod: routes.avatar, url: base + "/api/avatar/x", params: { id: "x" }, json: {} },
    { name: "GET inquiries", method: "GET", mod: routes.inquiries, url: base + "/api/inquiries" },
    { name: "PATCH inquiry", method: "PATCH", mod: routes.inquiry, url: base + "/api/inquiries/x", params: { id: "x" }, json: {} },
  );
  return out;
}

test("new e2e routes answer 401 without a session and keep Cache-Control", async () => {
  await locked(async () => {
    const { d1 } = openDb();
    setEnv(d1);
    asUser(null);
    const routes = await api();
    const hits = [
      ["GET", routes.keys, base + "/api/e2e/keys", {}],
      ["POST", routes.keys, base + "/api/e2e/keys", { json: {} }],
      ["PUT", routes.key, base + "/api/e2e/keys/x", { params: { id: "x" }, json: {} }],
      ["PATCH", routes.key, base + "/api/e2e/keys/x", { params: { id: "x" }, json: { touch: true } }],
      ["DELETE", routes.key, base + "/api/e2e/keys/x", { params: { id: "x" } }],
      ["GET", routes.records, base + "/api/e2e/records", {}],
      ["PUT", routes.record, base + "/api/e2e/records/contacts/c1", { params: { collection: "contacts", id: "c1" }, json: {} }],
      ["DELETE", routes.record, base + "/api/e2e/records/contacts/c1", { params: { collection: "contacts", id: "c1" }, json: { expectedVersion: 0 } }],
      ["POST", routes.counter, base + "/api/e2e/counter", { json: { kind: "quote" } }],
      ["POST", routes.scanAi, base + "/api/e2e/scan-ai", { form: form() }],
    ] as const;
    for (const [method, mod, url, opts] of hits) {
      const res = await call(mod, method, url, opts);
      assert.equal(res.status, 401, method + " " + url);
      assert.deepEqual(res.body, { error: "Unauthorized" });
      noStore(res.headers);
    }
    asUser("ana", "user", "pending");
    const pending = await call(routes.keys, "GET", base + "/api/e2e/keys");
    assert.equal(pending.status, 401);
  });
});

test("keys: activation, limits, replace, touch, delete and isolation", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    user(db, "beto");
    user(db, "root");
    db.prepare("UPDATE user SET role='admin' WHERE id=?").run("root");
    setEnv(d1);
    const routes = await api();

    asUser("ana");
    const empty = await call(routes.keys, "GET", base + "/api/e2e/keys");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { mode: "server", wraps: [], legacyData: false });
    noStore(empty.headers);

    const early = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "passkey", wrap: passkeyWrap(), credentialId: "credAna" } });
    assert.equal(early.status, 400);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id='ana'").get() as { m: string }).m, "server");

    asUser("root", "admin");
    const admin = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "admin-key" } });
    assert.equal(admin.status, 403);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id='root'").get() as { m: string }).m, "server");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id='root'").get() as { n: number }).n, 0);

    asUser("ana");
    const created = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw", credentialId: "nope" } });
    assert.equal(created.status, 400);
    const first = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw" } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body, { id: "pw", mode: "e2e" });
    noStore(first.headers);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id='ana'").get() as { m: string }).m, "e2e");
    const dup = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw2" } });
    assert.equal(dup.status, 409);
    const bad = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(1000), id: "pw3" } });
    assert.equal(bad.status, 400);
    for (let i = 0; i < 4; i++) {
      const added = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "passkey", wrap: passkeyWrap(), credentialId: "c" + i, id: "k" + i } });
      assert.equal(added.status, 201, JSON.stringify(added.body));
    }
    const limited = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "passkey", wrap: passkeyWrap(), credentialId: "c9", id: "k9" } });
    assert.equal(limited.status, 409);

    const listed = await call(routes.keys, "GET", base + "/api/e2e/keys");
    const wraps = (listed.body as { mode: string; wraps: { id: string; type: string; wrap: { m?: number }; credentialId: string | null; lastUsedAt: number | null }[] }).wraps;
    assert.equal((listed.body as { mode: string }).mode, "e2e");
    assert.deepEqual(wraps.map((row) => row.id).sort(), ["k0", "k1", "k2", "k3", "pw"]);
    const password = wraps.find((row) => row.id === "pw");
    assert.equal(password?.wrap.m, 65536);
    assert.equal(password?.credentialId, null);
    assert.equal(wraps.find((row) => row.id === "k0")?.credentialId, "c0");
    assert.equal(JSON.stringify(listed.body).includes("plain"), false);

    const replaced = await call(routes.key, "PUT", base + "/api/e2e/keys/pw", { params: { id: "pw" }, json: { wrap: passwordWrap(19456) } });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body, { ok: true });
    const notPassword = await call(routes.key, "PUT", base + "/api/e2e/keys/k0", { params: { id: "k0" }, json: { wrap: passwordWrap() } });
    assert.equal(notPassword.status, 409);
    const touched = await call(routes.key, "PATCH", base + "/api/e2e/keys/pw", { params: { id: "pw" }, json: { touch: true } });
    assert.equal(touched.status, 200);
    assert.equal((db.prepare("SELECT last_used_at AS t FROM user_keys WHERE id='pw'").get() as { t: number }).t > 0, true);
    const keepPassword = await call(routes.key, "DELETE", base + "/api/e2e/keys/pw", { params: { id: "pw" } });
    assert.equal(keepPassword.status, 409);
    const removed = await call(routes.key, "DELETE", base + "/api/e2e/keys/k0", { params: { id: "k0" } });
    assert.equal(removed.status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE id='k0'").get() as { n: number }).n, 0);

    const anaWraps = JSON.stringify(rows(db, "SELECT * FROM user_keys WHERE user_id='ana' ORDER BY id"));
    asUser("beto");
    const betoList = await call(routes.keys, "GET", base + "/api/e2e/keys");
    assert.deepEqual(betoList.body, { mode: "server", wraps: [], legacyData: false });
    const stealPut = await call(routes.key, "PUT", base + "/api/e2e/keys/pw", { params: { id: "pw" }, json: { wrap: passwordWrap(20000) } });
    const stealPatch = await call(routes.key, "PATCH", base + "/api/e2e/keys/k1", { params: { id: "k1" }, json: { touch: true } });
    const stealDel = await call(routes.key, "DELETE", base + "/api/e2e/keys/k1", { params: { id: "k1" } });
    assert.equal(stealPut.status, 404);
    assert.equal(stealPatch.status, 404);
    assert.equal(stealDel.status, 404);
    assert.equal(JSON.stringify(rows(db, "SELECT * FROM user_keys WHERE user_id='ana' ORDER BY id")), anaWraps);
    assert.equal((db.prepare("SELECT wrap AS m FROM user_keys WHERE id='pw'").get() as { m: string }).m.includes("19456"), true);
    assert.equal((listed.body as { legacyData: boolean }).legacyData, false);
  });
});

test("keys: plaintext rows block activation and stay in the account", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    user(db, "beto");
    db.prepare("INSERT INTO contacts (id,user_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("c-ana", "ana", "person", "Ana", 1, 1);
    setEnv(d1);
    const routes = await api();
    asUser("ana");
    const listed = await call(routes.keys, "GET", base + "/api/e2e/keys");
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { mode: string; legacyData: boolean }).mode, "server");
    assert.equal((listed.body as { legacyData: boolean }).legacyData, true);
    noStore(listed.headers);
    const blocked = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw" } });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body, { error: LEGACY_DATA_ERROR });
    assert.equal(JSON.stringify(blocked.body).includes("password"), false);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id='ana'").get() as { m: string }).m, "server");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id='ana'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT name FROM contacts WHERE id='c-ana'").get() as { name: string }).name, "Ana");
    asUser("beto");
    const other = await call(routes.keys, "GET", base + "/api/e2e/keys");
    assert.deepEqual(other.body, { mode: "server", wraps: [], legacyData: false });
    const created = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw-beto" } });
    assert.equal(created.status, 201);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id='c-ana'").get() as { n: number }).n, 1);
  });
});

test("records routes: shape, docs, tombstones, isolation, concurrency and counters", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    user(db, "beto");
    user(db, "root");
    db.prepare("UPDATE user SET role='admin' WHERE id=?").run("root");
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='ana'").run();
    setEnv(d1);
    const routes = await api();
    const put = (who: string, collection: string, id: string, json: unknown) => {
      asUser(who, who === "root" ? "admin" : "user");
      return call(routes.record, "PUT", base + "/api/e2e/records/" + collection + "/" + id, { params: { collection, id }, json });
    };

    asUser("beto");
    const blocked = await call(routes.records, "GET", base + "/api/e2e/records");
    assert.equal(blocked.status, 403);
    assert.deepEqual(blocked.body, { error: E2E_NOT_ENABLED });
    noStore(blocked.headers);
    const blockedPut = await put("beto", "contacts", "c1", { expectedVersion: 0, blob: BLOB });
    assert.deepEqual(blockedPut.body, { error: E2E_NOT_ENABLED });
    asUser("root", "admin");
    const adminGet = await call(routes.records, "GET", base + "/api/e2e/records");
    assert.equal(adminGet.status, 403);
    const adminCount = await call(routes.counter, "POST", base + "/api/e2e/counter", { json: { kind: "quote" } });
    assert.equal(adminCount.status, 403);

    asUser("ana");
    const extra = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: JSON.stringify({ v: 1, n: NONCE, c: CIPHER, plain: "x" }) });
    assert.equal(extra.status, 400);
    assert.deepEqual(extra.body, { error: ENVELOPE_ERROR });
    const plain = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: JSON.stringify({ name: "Ana", email: "a@b.c" }) });
    assert.equal(plain.status, 400);
    const huge = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: "x".repeat(1_900_001) });
    assert.equal(huge.status, 413);
    assert.deepEqual(huge.body, { error: BLOB_TOO_BIG_ERROR });
    const docElsewhere = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: BLOB, doc: { type: "invoice", number: 1, status: "draft", dueDate: null } });
    assert.equal(docElsewhere.status, 400);
    const inquiries = await put("ana", "inquiries", "c1", { expectedVersion: 0, blob: BLOB });
    assert.equal(inquiries.status, 400);
    assert.equal((await put("ana", "contacts", "bad id", { expectedVersion: 0, blob: BLOB })).status, 400);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n, 0);

    const created = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: BLOB });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body, { ok: true, version: 1, seq: 1 });
    noStore(created.headers);
    const conflict = await put("ana", "contacts", "c1", { expectedVersion: 0, blob: BLOB });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { currentVersion: 1 });
    const doc = await put("ana", "documents", "d1", { expectedVersion: 0, blob: BLOB, doc: { type: "invoice", number: 4, status: "sent", dueDate: "2026-12-01" } });
    assert.equal(doc.status, 201);
    const kept = await put("ana", "documents", "d1", { expectedVersion: 1, blob: BLOB });
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.body, { ok: true, version: 2, seq: 3 });
    const stored = db.prepare("SELECT doc_type, doc_number, doc_status, doc_due_date, deleted FROM records WHERE id='d1'").get() as { doc_type: string; doc_number: number; doc_status: string; doc_due_date: string; deleted: number };
    assert.equal(stored.doc_number, 4);
    assert.equal(stored.doc_due_date, "2026-12-01");
    assert.equal(stored.deleted, 0);

    const tomb = await call(routes.record, "DELETE", base + "/api/e2e/records/contacts/c1", { params: { collection: "contacts", id: "c1" }, json: { expectedVersion: 1 } });
    assert.equal(tomb.status, 200);
    assert.deepEqual(tomb.body, { ok: true, version: 2, seq: 4 });
    const dead = db.prepare("SELECT version, deleted, blob FROM records WHERE user_id='ana' AND id='c1'").get() as { version: number; deleted: number; blob: string };
    assert.equal(dead.version, 2);
    assert.equal(dead.deleted, 1);
    assert.equal(dead.blob, TOMBSTONE_BLOB);
    const staleTomb = await call(routes.record, "DELETE", base + "/api/e2e/records/contacts/c1", { params: { collection: "contacts", id: "c1" }, json: { expectedVersion: 1 } });
    assert.deepEqual(staleTomb.body, { currentVersion: 2 });
    const absent = await call(routes.record, "DELETE", base + "/api/e2e/records/contacts/nope", { params: { collection: "contacts", id: "nope" }, json: { expectedVersion: 1 } });
    assert.equal(absent.status, 404);

    const anaBefore = JSON.stringify(rows(db, "SELECT * FROM records WHERE user_id='ana' ORDER BY collection, id"));
    const overwrite = await put("beto", "contacts", "c1", { expectedVersion: 2, blob: BLOB });
    assert.equal(overwrite.status, 403);
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='beto'").run();
    const overwrite2 = await put("beto", "contacts", "c1", { expectedVersion: 2, blob: JSON.stringify({ v: 1, n: NONCE, c: "d".repeat(22) }) });
    assert.equal(overwrite2.status, 409);
    assert.deepEqual(overwrite2.body, { currentVersion: 0 });
    const del = await call(routes.record, "DELETE", base + "/api/e2e/records/contacts/c1", { params: { collection: "contacts", id: "c1" }, json: { expectedVersion: 2 } });
    assert.equal(del.status, 404);
    const own = await put("beto", "contacts", "c1", { expectedVersion: 0, blob: BLOB });
    assert.equal(own.status, 201);
    assert.equal(JSON.stringify(rows(db, "SELECT * FROM records WHERE user_id='ana' ORDER BY collection, id")), anaBefore);
    asUser("beto");
    const betoList = await call(routes.records, "GET", base + "/api/e2e/records");
    assert.equal(JSON.stringify(betoList.body).includes(TOMBSTONE_BLOB), false);
    assert.equal((betoList.body as { records: { id: string }[] }).records.length, 1);

    asUser("ana");
    const listed = await call(routes.records, "GET", base + "/api/e2e/records?limit=1");
    assert.equal(listed.status, 200);
    const page = listed.body as { records: { id: string; seq: number; deleted: boolean; docNumber: number | null }[]; cursor: number; more: boolean };
    assert.equal(page.records.length, 1);
    assert.equal(page.more, true);
    assert.equal(page.cursor, page.records[0].seq);
    const next = await call(routes.records, "GET", base + "/api/e2e/records?since=" + page.cursor + "&limit=10");
    assert.equal((next.body as { more: boolean }).more, false);
    const docs = await call(routes.records, "GET", base + "/api/e2e/records?collection=documents");
    const docRows = (docs.body as { records: { id: string; docNumber: number; deleted: boolean }[] }).records;
    assert.deepEqual(docRows.map((row) => row.id), ["d1"]);
    assert.equal(docRows[0].docNumber, 4);
    const contacts = await call(routes.records, "GET", base + "/api/e2e/records?collection=contacts");
    assert.equal((contacts.body as { records: { deleted: boolean; blob: string; version: number }[] }).records[0].deleted, true);
    assert.equal((contacts.body as { records: { blob: string }[] }).records[0].blob, TOMBSTONE_BLOB);
    assert.equal((await call(routes.records, "GET", base + "/api/e2e/records?limit=501")).status, 400);
    assert.equal((await call(routes.records, "GET", base + "/api/e2e/records?collection=inquiries")).status, 400);

    const idsParallel = Array.from({ length: 12 }, (_, i) => "p" + i);
    const parallel = await Promise.all(idsParallel.map((id) => put("ana", "projects", id, { expectedVersion: 0, blob: BLOB })));
    assert.equal(parallel.every((res) => res.status === 201), true);
    const seqs = parallel.map((res) => (res.body as { seq: number }).seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => seqs[0] + i));
    const beforeSeq = (db.prepare("SELECT value FROM e2e_counters WHERE user_id='ana' AND kind='seq'").get() as { value: number }).value;
    const [left, right] = await Promise.all([
      put("ana", "projects", "p0", { expectedVersion: 1, blob: BLOB }),
      put("ana", "projects", "p0", { expectedVersion: 1, blob: BLOB }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = left.status === 409 ? left : right;
    assert.deepEqual(loser.body, { currentVersion: 2 });
    assert.equal((db.prepare("SELECT version FROM records WHERE user_id='ana' AND id='p0'").get() as { version: number }).version, 2);
    assert.equal((db.prepare("SELECT value FROM e2e_counters WHERE user_id='ana' AND kind='seq'").get() as { value: number }).value, beforeSeq + 1);

    const quotes = await Promise.all(Array.from({ length: 50 }, () => call(routes.counter, "POST", base + "/api/e2e/counter", { json: { kind: "quote" } })));
    const values = quotes.map((res) => (res.body as { value: number }).value).sort((a, b) => a - b);
    assert.equal(quotes.every((res) => res.status === 200), true);
    assert.deepEqual(values, Array.from({ length: 50 }, (_, i) => i + 1));
    const invoice = await call(routes.counter, "POST", base + "/api/e2e/counter", { json: { kind: "invoice" } });
    assert.deepEqual(invoice.body, { value: 1 });
    asUser("beto");
    const betoQuote = await call(routes.counter, "POST", base + "/api/e2e/counter", { json: { kind: "quote" } });
    assert.deepEqual(betoQuote.body, { value: 1 });
    assert.equal((await call(routes.counter, "POST", base + "/api/e2e/counter", { json: { kind: "seq" } })).status, 400);
  });
});

test("an e2e account gets 403 on every legacy plaintext route and push still answers", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id=?").run(B);
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const before = snap(db);
    const hits = legacyHits(routes);
    assert.equal(hits.length, 46);
    for (const hit of hits) {
      const res = await call(hit.mod, hit.method, hit.url, { params: hit.params, json: hit.json, form: hit.form });
      assert.equal(res.status, 403, hit.name + " " + JSON.stringify(res.body));
      assert.deepEqual(res.body, { error: ENCRYPTED });
      noStore(res.headers);
    }
    assertSame(db, before);
    const push = await call(routes.push, "GET", base + "/api/push/subscribe");
    assert.equal(push.status, 200);
    assert.equal((push.body as { publicKey: string }).publicKey, "test-vapid-public");
    const unknown = await call(routes.list, "GET", base + "/api/data/nope", { params: { resource: "nope" } });
    assert.equal(unknown.status, 404);
  });
});

test("server-mode reads and writes stay on the plaintext routes", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const seen: string[] = [];
    const mark = (name: string) => seen.push(name);

    for (const resource of ["contacts", "projects", "tasks", "accounts", "transactions", "activities"] as const) {
      const res = await call(routes.list, "GET", base + "/api/data/" + resource, { params: { resource } });
      assert.equal(res.status, 200, resource);
      assert.equal(JSON.stringify(res.body).includes("A-SECRET"), false);
      mark("GET data " + resource);
    }
    const contacts = await call(routes.list, "GET", base + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.match(JSON.stringify(contacts.body), /B-CONTACT/);
    const txs = await call(routes.list, "GET", base + "/api/data/transactions", { params: { resource: "transactions" } });
    assert.deepEqual((txs.body as { items: { id: string; amountMinor: number }[] }).items.map((row) => [row.id, row.amountMinor]), [[ids.txB, 100]]);
    const finance = await call(routes.finance, "GET", base + "/api/finance/totals");
    assert.deepEqual(finance.body, { ARS: { incomeMinor: 0, expenseMinor: 100 }, USD: { incomeMinor: 0, expenseMinor: 0 }, transactionCount: 1 });
    mark("GET finance");
    const docs = await call(routes.docs, "GET", base + "/api/documents");
    assert.equal(docs.status, 200);
    assert.deepEqual((docs.body as { items: { id: string; totalMinor: number }[] }).items.map((row) => [row.id, row.totalMinor]), [[ids.docB, 100]]);
    assert.equal((docs.body as { issuer: { email: string } }).issuer.email, B + "@test.local");
    mark("GET documents");
    const one = await call(routes.doc, "GET", base + "/api/documents/" + ids.docB, { params: { id: ids.docB } });
    assert.deepEqual((one.body as { items: { description: string }[] }).items.map((row) => row.description), ["B-ITEM"]);
    mark("GET document");
    const hours = await call(routes.hours, "GET", base + "/api/documents/time-entries?contactId=" + ids.contactB + "&currency=ARS");
    assert.deepEqual((hours.body as { items: { id: string }[] }).items.map((row) => row.id), [ids.entryB]);
    mark("GET document hours");
    const times = await call(routes.entries, "GET", base + "/api/time-entries");
    assert.match(JSON.stringify(times.body), /horas b/);
    mark("GET time-entries");
    const clock = await call(routes.timer, "GET", base + "/api/timer");
    assert.equal((clock.body as { timer: { startedAt: number } }).timer.startedAt, 222222);
    mark("GET timer");
    const rules = await call(routes.rules, "GET", base + "/api/recurring");
    assert.equal(rules.status, 200);
    assert.equal((rules.body as { items: { id: string }[] }).items.some((row) => row.id === ids.ruleB), true);
    mark("GET recurring");
    const file = await call(routes.receipt, "GET", base + "/api/receipts/" + ids.receiptB, { params: { id: ids.receiptB } });
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "image/png");
    mark("GET receipt");
    const photo = await call(routes.avatar, "GET", base + "/api/avatar/" + ids.contactB, { params: { id: ids.contactB } });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers["content-type"], "image/png");
    mark("GET avatar");
    const inquiries = await call(routes.inquiries, "GET", base + "/api/inquiries");
    assert.match(JSON.stringify(inquiries.body), /B-INQ/);
    mark("GET inquiries");

    const contact = await call(routes.list, "POST", base + "/api/data/contacts", { params: { resource: "contacts" }, json: { name: "Nuevo" } });
    assert.equal(contact.status, 201);
    assert.equal((contact.body as { ok: boolean }).ok, true);
    const contactId = (contact.body as { id: string }).id;
    mark("POST data contacts");
    const contactPatch = await call(routes.one, "PATCH", base + "/api/data/contacts/" + contactId, { params: { resource: "contacts", id: contactId }, json: { name: "Nuevo 2" } });
    assert.deepEqual(contactPatch.body, { ok: true });
    mark("PATCH data contacts");
    const contactDel = await call(routes.one, "DELETE", base + "/api/data/contacts/" + contactId, { params: { resource: "contacts", id: contactId } });
    assert.deepEqual(contactDel.body, { ok: true });
    mark("DELETE data contacts");

    const project = await call(routes.list, "POST", base + "/api/data/projects", { params: { resource: "projects" }, json: { name: "Proyecto" } });
    assert.equal(project.status, 201);
    const projectId = (project.body as { id: string }).id;
    mark("POST data projects");
    assert.deepEqual((await call(routes.one, "PATCH", base + "/api/data/projects/" + projectId, { params: { resource: "projects", id: projectId }, json: { name: "Proyecto 2" } })).body, { ok: true });
    mark("PATCH data projects");
    assert.deepEqual((await call(routes.one, "DELETE", base + "/api/data/projects/" + projectId, { params: { resource: "projects", id: projectId } })).body, { ok: true });
    mark("DELETE data projects");

    const task = await call(routes.list, "POST", base + "/api/data/tasks", { params: { resource: "tasks" }, json: { title: "Tarea" } });
    assert.equal(task.status, 201);
    const taskId = (task.body as { id: string }).id;
    mark("POST data tasks");
    assert.deepEqual((await call(routes.one, "PATCH", base + "/api/data/tasks/" + taskId, { params: { resource: "tasks", id: taskId }, json: { title: "Tarea 2" } })).body, { ok: true });
    mark("PATCH data tasks");
    assert.deepEqual((await call(routes.one, "DELETE", base + "/api/data/tasks/" + taskId, { params: { resource: "tasks", id: taskId } })).body, { ok: true });
    mark("DELETE data tasks");

    const account = await call(routes.list, "POST", base + "/api/data/accounts", { params: { resource: "accounts" }, json: { name: "Caja", currency: "ARS", openingBalanceMinor: 0 } });
    assert.equal(account.status, 201);
    const accountId = (account.body as { id: string }).id;
    mark("POST data accounts");
    assert.deepEqual((await call(routes.one, "PATCH", base + "/api/data/accounts/" + accountId, { params: { resource: "accounts", id: accountId }, json: { name: "Caja 2" } })).body, { ok: true });
    mark("PATCH data accounts");
    assert.deepEqual((await call(routes.one, "DELETE", base + "/api/data/accounts/" + accountId, { params: { resource: "accounts", id: accountId } })).body, { ok: true });
    mark("DELETE data accounts");

    const tx = await call(routes.list, "POST", base + "/api/data/transactions", { params: { resource: "transactions" }, json: txBody(ids.accountB) });
    assert.equal(tx.status, 201, JSON.stringify(tx.body));
    const txId = (tx.body as { id: string }).id;
    mark("POST data transactions");
    assert.deepEqual((await call(routes.one, "PATCH", base + "/api/data/transactions/" + txId, { params: { resource: "transactions", id: txId }, json: txBody(ids.accountB, { amountMinor: 180 }) })).body, { ok: true });
    mark("PATCH data transactions");
    assert.deepEqual((await call(routes.one, "DELETE", base + "/api/data/transactions/" + txId, { params: { resource: "transactions", id: txId } })).body, { ok: true });
    mark("DELETE data transactions");

    const activity = await call(routes.list, "POST", base + "/api/data/activities", { params: { resource: "activities" }, json: { title: "Nota", kind: "note" } });
    assert.equal(activity.status, 201);
    const activityId = (activity.body as { id: string }).id;
    mark("POST data activities");
    assert.deepEqual((await call(routes.one, "PATCH", base + "/api/data/activities/" + activityId, { params: { resource: "activities", id: activityId }, json: { title: "Nota 2", kind: "note", contactIds: [] } })).body, { ok: true });
    mark("PATCH data activities");
    assert.deepEqual((await call(routes.one, "DELETE", base + "/api/data/activities/" + activityId, { params: { resource: "activities", id: activityId } })).body, { ok: true });
    mark("DELETE data activities");

    const draft = await call(routes.docs, "POST", base + "/api/documents", { json: docBody(ids.contactB) });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    assert.equal((draft.body as { ok: boolean; number: number }).ok, true);
    assert.equal((draft.body as { number: number }).number, 2);
    const draftId = (draft.body as { id: string }).id;
    mark("POST documents");
    assert.deepEqual((await call(routes.doc, "PATCH", base + "/api/documents/" + ids.docB, { params: { id: ids.docB }, json: { action: "status", status: "sent" } })).body, { ok: true });
    mark("PATCH document");
    assert.deepEqual((await call(routes.doc, "DELETE", base + "/api/documents/" + draftId, { params: { id: draftId } })).body, { ok: true });
    mark("DELETE document");

    const entry = await call(routes.entries, "POST", base + "/api/time-entries", { json: entryBody(ids.taskB) });
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    assert.equal((entry.body as { ok: boolean }).ok, true);
    const entryId = (entry.body as { id: string }).id;
    mark("POST time-entries");
    assert.deepEqual((await call(routes.entry, "DELETE", base + "/api/time-entries/" + entryId, { params: { id: entryId } })).body, { ok: true });
    mark("DELETE time-entry");

    const paused = await call(routes.timer, "POST", base + "/api/timer", { json: { action: "pause" } });
    assert.equal(paused.status, 200);
    assert.equal((paused.body as { timer: { startedAt: number; segmentStart: null } }).timer.startedAt, 222222);
    assert.equal((paused.body as { timer: { segmentStart: null } }).timer.segmentStart, null);
    mark("POST timer");
    assert.deepEqual((await call(routes.rule, "PATCH", base + "/api/recurring/" + ids.ruleB, { params: { id: ids.ruleB }, json: { action: "pause" } })).body, { ok: true });
    mark("PATCH recurring");
    assert.deepEqual((await call(routes.rule, "DELETE", base + "/api/recurring/" + ids.ruleB, { params: { id: ids.ruleB } })).body, { ok: true });
    mark("DELETE recurring");

    const scanned = await call(routes.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(scanned.status, 201, JSON.stringify(scanned.body));
    assert.equal((scanned.body as { ok: boolean; aiStatus: string; message: string }).ok, false);
    assert.equal((scanned.body as { aiStatus: string }).aiStatus, "disabled");
    assert.equal((scanned.body as { message: string }).message, AI_DISABLED_MESSAGE);
    assert.equal(typeof (scanned.body as { receiptId: string }).receiptId, "string");
    mark("POST scan");
    assert.deepEqual((await call(routes.receipt, "DELETE", base + "/api/receipts/" + ids.receiptBFree, { params: { id: ids.receiptBFree } })).body, { ok: true });
    mark("DELETE receipt");
    const bare = await call(routes.list, "POST", base + "/api/data/contacts", { params: { resource: "contacts" }, json: { name: "Sin foto" } });
    const bareId = (bare.body as { id: string }).id;
    assert.deepEqual((await call(routes.avatar, "POST", base + "/api/avatar/" + bareId, { params: { id: bareId }, json: { failedKey: "lookup" } })).body, { ok: true });
    mark("POST avatar");
    const chosen = await call(routes.avatar, "POST", base + "/api/avatar/" + ids.contactB, { params: { id: ids.contactB }, json: { failedKey: "lookup" } });
    assert.equal(chosen.status, 409);
    assert.deepEqual(chosen.body, { error: "La foto ya fue elegida" });
    assert.deepEqual((await call(routes.inquiry, "PATCH", base + "/api/inquiries/" + ids.inquiryB, { params: { id: ids.inquiryB }, json: { action: "read" } })).body, { ok: true });
    mark("PATCH inquiry");

    assert.equal(seen.length, 46, seen.join(","));
    assert.equal(JSON.stringify(db.prepare("SELECT name FROM contacts WHERE id=?").get(ids.contactA)).includes("A-SECRET-CONTACT"), true);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id=?").get(B) as { m: string }).m, "server");
    assert.equal(db.prepare("SELECT id FROM records").all().length, 0);
  });
});

test("an admin stays in server mode, keeps the plaintext scan, and the user list shows encryptionMode", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    db.prepare("UPDATE user SET role='admin' WHERE id=?").run(A);
    setEnv(d1);
    asUser(A, "admin");
    const routes = await api();
    const finance = await call(routes.finance, "GET", base + "/api/finance/totals");
    assert.deepEqual(finance.body, { ARS: { incomeMinor: 0, expenseMinor: 424242 }, USD: { incomeMinor: 0, expenseMinor: 0 }, transactionCount: 1 });
    const contacts = await call(routes.list, "GET", base + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.match(JSON.stringify(contacts.body), /A-SECRET-CONTACT/);
    const clock = await call(routes.timer, "GET", base + "/api/timer");
    assert.equal((clock.body as { timer: { startedAt: number } }).timer.startedAt, 111111);
    const scan = await call(routes.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    assert.equal(typeof (scan.body as { receiptId: string }).receiptId, "string");
    assert.equal(JSON.stringify(scan.body).includes(ENCRYPTED), false);
    const refused = await call(routes.keys, "POST", base + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "no-admin" } });
    assert.equal(refused.status, 403);
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id=?").get(A) as { m: string }).m, "server");
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id=?").run(B);
    const listed = await call(routes.admin, "GET", base + "/api/admin/users");
    assert.equal(listed.status, 200);
    const users = (listed.body as { users: { id: string; encryptionMode: string }[] }).users;
    assert.equal(users.find((row) => row.id === A)?.encryptionMode, "server");
    assert.equal(users.find((row) => row.id === B)?.encryptionMode, "e2e");
    assert.equal(JSON.stringify(listed.body).includes("blob"), false);
    assert.equal(JSON.stringify(listed.body).includes(ENCRYPTED), false);
  });
});

test("scan-ai is e2e-only, stores nothing, and uses the same quotas", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    user(db, "beto");
    setEnv(d1);
    const env = globalThis.__testEnv as { AI: { run: () => Promise<unknown> } };
    env.AI.run = async () => ({ response: '{"amount":"10,50","currency":"ARS","date":"2026-10-01","merchant":"Kiosco","category":"Comida"}' });
    const routes = await api();
    const day = todayInBuenosAires(Date.now());
    const utc = utcDay(Date.now());
    const usage = (scope: string, kind: string, when = scope === "global" ? utc : day) => {
      const row = db.prepare("SELECT amount FROM usage_daily WHERE day=? AND scope=? AND kind=?").get(when, scope, kind) as { amount: number } | undefined;
      return row?.amount ?? 0;
    };
    const stored = () => (db.prepare("SELECT (SELECT COUNT(*) FROM receipts WHERE user_id='ana') + (SELECT COUNT(*) FROM records WHERE user_id='ana') AS n").get() as { n: number }).n;

    asUser("beto");
    const server = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(server.status, 403);
    assert.deepEqual(server.body, { error: E2E_NOT_ENABLED });

    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='ana'").run();
    asUser("ana");
    const disabled = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body as { ok: boolean }).ok, false);
    assert.equal((disabled.body as { aiStatus: string }).aiStatus, "disabled");
    assert.equal((disabled.body as { message: string }).message, AI_DISABLED_MESSAGE);
    assert.equal((disabled.body as { warning: string }).warning, SCAN_AI_WARNING);
    assert.equal((disabled.body as { fields: null }).fields, null);
    assert.equal(stored(), 0);
    assert.equal(usage("ana", "receipt_scans"), 0);

    db.prepare("UPDATE user SET ai_receipts_enabled=1 WHERE id='ana'").run();
    const ok = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((ok.body as { ok: boolean }).ok, true);
    assert.equal((ok.body as { fields: { merchant: string } }).fields.merchant, "Kiosco");
    assert.equal((ok.body as { warning: string }).warning, SCAN_AI_WARNING);
    assert.equal(ok.body && JSON.stringify(ok.body).includes("receiptId"), false);
    assert.equal(stored(), 0);
    assert.equal(usage("ana", "receipt_scans"), 1);
    assert.equal(usage("global", "ai_neurons"), NEURONS_PER_SCAN_ESTIMATE);

    db.prepare("UPDATE usage_daily SET amount=? WHERE day=? AND scope='ana' AND kind='receipt_scans'").run(INVITEE_RECEIPT_SCANS_PER_DAY, day);
    const limited = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: SCAN_LIMIT_MESSAGE });
    assert.equal(stored(), 0);

    db.prepare("UPDATE usage_daily SET amount=0 WHERE day=? AND scope='ana' AND kind='receipt_scans'").run(day);
    db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, 'global', 'ai_neurons', ?) ON CONFLICT(day, scope, kind) DO UPDATE SET amount=excluded.amount").run(utc, AI_CUTOFF_NEURONS);
    const global = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(global.status, 200);
    assert.equal((global.body as { aiStatus: string }).aiStatus, "global_limit");
    assert.equal((global.body as { message: string }).message, AI_GLOBAL_LIMIT_MESSAGE);
    assert.equal((global.body as { warning: string }).warning, SCAN_AI_WARNING);
    assert.equal(usage("ana", "receipt_scans"), 0);
    assert.equal(usage("global", "ai_neurons"), AI_CUTOFF_NEURONS);
    assert.equal(stored(), 0);

    db.prepare("UPDATE usage_daily SET amount=0 WHERE day=? AND scope='global' AND kind='ai_neurons'").run(utc);
    setEnv(d1, { AI: undefined });
    const skipped = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form() });
    assert.equal(skipped.status, 200);
    assert.equal((skipped.body as { ok: boolean }).ok, false);
    assert.equal((skipped.body as { warning: string }).warning, SCAN_AI_WARNING);
    assert.equal(usage("ana", "receipt_scans"), 0);
    assert.equal(usage("global", "ai_neurons"), 0);
    assert.equal(stored(), 0);

    setEnv(d1);
    const bad = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form(new File([Uint8Array.from([1, 2, 3, 4, 5, 6])], "x.bin")) });
    assert.equal(bad.status, 415);
    assert.deepEqual(bad.body, { error: "Formato no admitido. Usá JPG, PNG, WebP o PDF." });
    const big = new Uint8Array(1_400_001);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    const tooBig = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: form(new File([big], "big.png")) });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(tooBig.body, { error: RECEIPT_TOO_BIG_MESSAGE });
    const missing = await call(routes.scanAi, "POST", base + "/api/e2e/scan-ai", { form: new FormData() });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: "Falta el archivo" });
    assert.equal(stored(), 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n, 0);
  });
});
