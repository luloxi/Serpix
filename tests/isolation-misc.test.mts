import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateInvite } from "../lib/invites.ts";
import { asUser, call, locked, resetSessionReads, sessionReads, setEnv } from "./route-harness.mts";
import { A, B, assert4xx, assertNoA, assertSame, ids, P256, PUSH_AUTH, seedWorld, snap } from "./isolation-shared.mts";

const base = "http://t.local";
const root = fileURLToPath(new URL("..", import.meta.url));

/** Every app/api route. auth/[...all] is the better-auth handler and is out of scope. */
const COVERED = [
  "admin/invites/[id]/route.ts",
  "admin/invites/route.ts",
  "admin/users/route.ts",
  "admin/users/[userId]/route.ts",
  "avatar/[id]/route.ts",
  "data/[resource]/route.ts",
  "data/[resource]/[id]/route.ts",
  "documents/route.ts",
  "documents/[id]/route.ts",
  "documents/time-entries/route.ts",
  "e2e/counter/route.ts",
  "e2e/keys/[id]/route.ts",
  "e2e/keys/route.ts",
  "e2e/records/[collection]/[id]/route.ts",
  "e2e/records/route.ts",
  "e2e/scan-ai/route.ts",
  "finance/totals/route.ts",
  "inbound/portfolio/route.ts",
  "inquiries/route.ts",
  "inquiries/[id]/route.ts",
  "integrations/cuentix/events/route.ts",
  "invites/redeem/route.ts",
  "luma-events/route.ts",
  "push/subscribe/route.ts",
  "receipts/scan/route.ts",
  "receipts/[id]/route.ts",
  "recurring/route.ts",
  "recurring/[id]/route.ts",
  "time-entries/route.ts",
  "time-entries/[id]/route.ts",
  "timer/route.ts",
];
const OUT_OF_SCOPE = ["auth/[...all]/route.ts"];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (name === "route.ts") out.push(relative(join(root, "app/api"), path).split(sep).join("/"));
  }
  return out.sort();
}

test("every API route file is listed for isolation coverage", () => {
  const found = routeFiles(join(root, "app/api"));
  assert.deepEqual(found, [...COVERED, ...OUT_OF_SCOPE].sort());
  assert.deepEqual(OUT_OF_SCOPE, ["auth/[...all]/route.ts"]);
});

async function api() {
  return {
    list: await import("../app/api/data/[resource]/route.ts"),
    one: await import("../app/api/data/[resource]/[id]/route.ts"),
    finance: await import("../app/api/finance/totals/route.ts"),
    avatar: await import("../app/api/avatar/[id]/route.ts"),
    admin: await import("../app/api/admin/users/route.ts"),
    adminUser: await import("../app/api/admin/users/[userId]/route.ts"),
    adminInvites: await import("../app/api/admin/invites/route.ts"),
    adminInvite: await import("../app/api/admin/invites/[id]/route.ts"),
    docs: await import("../app/api/documents/route.ts"),
    doc: await import("../app/api/documents/[id]/route.ts"),
    hours: await import("../app/api/documents/time-entries/route.ts"),
    entries: await import("../app/api/time-entries/route.ts"),
    entry: await import("../app/api/time-entries/[id]/route.ts"),
    timer: await import("../app/api/timer/route.ts"),
    inquiries: await import("../app/api/inquiries/route.ts"),
    inquiry: await import("../app/api/inquiries/[id]/route.ts"),
    push: await import("../app/api/push/subscribe/route.ts"),
    scan: await import("../app/api/receipts/scan/route.ts"),
    receipt: await import("../app/api/receipts/[id]/route.ts"),
    cuentix: await import("../app/api/integrations/cuentix/events/route.ts"),
    rules: await import("../app/api/recurring/route.ts"),
    rule: await import("../app/api/recurring/[id]/route.ts"),
    e2eKeys: await import("../app/api/e2e/keys/route.ts"),
    e2eKey: await import("../app/api/e2e/keys/[id]/route.ts"),
    e2eRecords: await import("../app/api/e2e/records/route.ts"),
    e2eRecord: await import("../app/api/e2e/records/[collection]/[id]/route.ts"),
    e2eCounter: await import("../app/api/e2e/counter/route.ts"),
    e2eScan: await import("../app/api/e2e/scan-ai/route.ts"),
    luma: await import("../app/api/luma-events/route.ts"),
  };
}

type Hit = { method: string; mod: Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>; url: string; params?: Record<string, string>; json?: unknown };

function hits(routes: Awaited<ReturnType<typeof api>>): Hit[] {
  const resources = ["contacts", "projects", "tasks", "accounts", "transactions", "activities"];
  const out: Hit[] = [];
  for (const resource of resources) {
    out.push({ method: "GET", mod: routes.list, url: base + "/api/data/" + resource, params: { resource } });
    out.push({ method: "POST", mod: routes.list, url: base + "/api/data/" + resource, params: { resource }, json: { name: "X", title: "X" } });
    out.push({ method: "PATCH", mod: routes.one, url: base + "/api/data/" + resource + "/x", params: { resource, id: "x" }, json: { name: "X", title: "X" } });
    out.push({ method: "DELETE", mod: routes.one, url: base + "/api/data/" + resource + "/x", params: { resource, id: "x" } });
  }
  out.push(
    { method: "GET", mod: routes.finance, url: base + "/api/finance/totals" },
    { method: "GET", mod: routes.avatar, url: base + "/api/avatar/x", params: { id: "x" } },
    { method: "POST", mod: routes.avatar, url: base + "/api/avatar/x", params: { id: "x" }, json: { failedKey: "x" } },
    { method: "GET", mod: routes.admin, url: base + "/api/admin/users" },
    { method: "PATCH", mod: routes.adminUser, url: base + "/api/admin/users/x", params: { userId: "x" }, json: { approvalStatus: "rejected" } },
    { method: "GET", mod: routes.adminInvites, url: base + "/api/admin/invites" },
    { method: "POST", mod: routes.adminInvites, url: base + "/api/admin/invites", json: {} },
    { method: "DELETE", mod: routes.adminInvite, url: base + "/api/admin/invites/x", params: { id: "x" } },
    { method: "GET", mod: routes.docs, url: base + "/api/documents" },
    { method: "POST", mod: routes.docs, url: base + "/api/documents", json: { type: "invoice" } },
    { method: "GET", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" } },
    { method: "PATCH", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" }, json: { action: "status", status: "sent" } },
    { method: "DELETE", mod: routes.doc, url: base + "/api/documents/x", params: { id: "x" } },
    { method: "GET", mod: routes.hours, url: base + "/api/documents/time-entries?contactId=x" },
    { method: "GET", mod: routes.entries, url: base + "/api/time-entries" },
    { method: "POST", mod: routes.entries, url: base + "/api/time-entries", json: {} },
    { method: "DELETE", mod: routes.entry, url: base + "/api/time-entries/x", params: { id: "x" } },
    { method: "GET", mod: routes.timer, url: base + "/api/timer" },
    { method: "POST", mod: routes.timer, url: base + "/api/timer", json: { action: "discard" } },
    { method: "GET", mod: routes.inquiries, url: base + "/api/inquiries" },
    { method: "PATCH", mod: routes.inquiry, url: base + "/api/inquiries/x", params: { id: "x" }, json: { action: "read" } },
    { method: "GET", mod: routes.push, url: base + "/api/push/subscribe" },
    { method: "POST", mod: routes.push, url: base + "/api/push/subscribe", json: {} },
    { method: "DELETE", mod: routes.push, url: base + "/api/push/subscribe", json: { endpoint: "https://push.example.test/nope" } },
    { method: "POST", mod: routes.scan, url: base + "/api/receipts/scan" },
    { method: "GET", mod: routes.receipt, url: base + "/api/receipts/x", params: { id: "x" } },
    { method: "DELETE", mod: routes.receipt, url: base + "/api/receipts/x", params: { id: "x" } },
    { method: "POST", mod: routes.cuentix, url: base + "/api/integrations/cuentix/events", json: {} },
    { method: "GET", mod: routes.rules, url: base + "/api/recurring" },
    { method: "PATCH", mod: routes.rule, url: base + "/api/recurring/x", params: { id: "x" }, json: { action: "pause" } },
    { method: "DELETE", mod: routes.rule, url: base + "/api/recurring/x", params: { id: "x" } },
    { method: "GET", mod: routes.e2eKeys, url: base + "/api/e2e/keys" },
    { method: "POST", mod: routes.e2eKeys, url: base + "/api/e2e/keys", json: {} },
    { method: "PUT", mod: routes.e2eKey, url: base + "/api/e2e/keys/x", params: { id: "x" }, json: {} },
    { method: "PATCH", mod: routes.e2eKey, url: base + "/api/e2e/keys/x", params: { id: "x" }, json: { touch: true } },
    { method: "DELETE", mod: routes.e2eKey, url: base + "/api/e2e/keys/x", params: { id: "x" } },
    { method: "GET", mod: routes.e2eRecords, url: base + "/api/e2e/records" },
    { method: "PUT", mod: routes.e2eRecord, url: base + "/api/e2e/records/contacts/x", params: { collection: "contacts", id: "x" }, json: {} },
    { method: "DELETE", mod: routes.e2eRecord, url: base + "/api/e2e/records/contacts/x", params: { collection: "contacts", id: "x" }, json: { expectedVersion: 0 } },
    { method: "POST", mod: routes.e2eCounter, url: base + "/api/e2e/counter", json: { kind: "quote" } },
    { method: "POST", mod: routes.e2eScan, url: base + "/api/e2e/scan-ai" },
    { method: "GET", mod: routes.luma, url: base + "/api/luma-events" },
  );
  return out;
}

for (const [label, session] of [["no session", null], ["pending user", "pending"]] as const) {
  test(label + " gets 401 on every session route", async () => {
    await locked(async () => {
      const { d1 } = seedWorld();
      setEnv(d1);
      if (session === null) asUser(null);
      else asUser(B, "user", "pending");
      const routes = await api();
      for (const hit of hits(routes)) {
        const res = await call(hit.mod, hit.method, hit.url, { params: hit.params, json: hit.json });
        assert.equal(res.status, 401, label + " " + hit.method + " " + hit.url + " -> " + res.status + " " + JSON.stringify(res.body));
      }
    });
  });
}

test("paused invites are not created or redeemed and do not change another user's rows", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    db.prepare("UPDATE user SET approvalStatus='pending' WHERE id=?").run(B);
    const created = await generateInvite(d1, A, Date.now(), undefined, { enabled: true });
    setEnv(d1);
    const before = snap(db);
    asUser(B, "user", "pending");
    const redeem = await import("../app/api/invites/redeem/route.ts");
    const pausedRedeem = await call(redeem, "POST", base + "/api/invites/redeem", { json: { code: created.code } });
    assert.equal(pausedRedeem.status, 423);
    assert.deepEqual(pausedRedeem.body, { status: "disabled" });
    assert.equal(JSON.stringify(pausedRedeem.body).includes(created.code), false);
    assertSame(db, before);
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id=?").get(B) as { s: string }).s, "pending");

    const routes = await api();
    asUser(B);
    const forbidden = await call(routes.adminInvites, "POST", base + "/api/admin/invites", { json: { note: "no" } });
    assert.equal(forbidden.status, 403);
    assertSame(db, before);

    asUser(A, "admin");
    const pausedCreate = await call(routes.adminInvites, "POST", base + "/api/admin/invites", { json: { note: "no" } });
    assert.equal(pausedCreate.status, 423);
    assert.deepEqual(pausedCreate.body, { error: "Las invitaciones están pausadas por ahora." });
    assertSame(db, before);
    const listed = await call(routes.adminInvites, "GET", base + "/api/admin/invites");
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { enabled: boolean }).enabled, false);
    assert.equal(JSON.stringify(listed.body).includes(created.code), false);
  });
});

test("portfolio inbound ignores the session and rejects a missing secret", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(A, "admin");
    const inbound = await import("../app/api/inbound/portfolio/route.ts");
    const before = snap(db);
    resetSessionReads();
    const missing = await call(inbound, "POST", base + "/api/inbound/portfolio", { json: { name: "X", email: "a@b.co", message: "hola" } });
    assert.ok(missing.status === 401 || missing.status === 403, String(missing.status));
    const wrong = await call(inbound, "POST", base + "/api/inbound/portfolio", { json: { name: "X", email: "a@b.co", message: "hola" }, headers: { "x-serpix-secret": "nope" } });
    assert.ok(wrong.status === 401 || wrong.status === 403, String(wrong.status));
    assert.equal(sessionReads(), 0);
    assertSame(db, before);
  });
});

test("cuentix sync ignores the session and a bad signature writes nothing", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1, { CUENTIX_SYNC_SECRET: "test-secret-not-real", CUENTIX_SYNC_OWNER_EMAIL: A + "@test.local" });
    asUser(B, "user", "approved");
    const route = await import("../app/api/integrations/cuentix/events/route.ts");
    const before = snap(db);
    resetSessionReads();
    const res = await call(route, "POST", base + "/api/integrations/cuentix/events", {
      text: "{}",
      headers: {
        "x-sync-timestamp": String(Date.now()),
        "x-sync-nonce": "00112233445566778899aabbccddeeff",
        "x-sync-signature": "v1=" + "ab".repeat(32),
      },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
    assert.equal(sessionReads(), 0);
    assertSame(db, before);
  });
});

test("B cannot read or touch A's inquiries, rules, receipts or push subscription", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const inquiries = await call(routes.inquiries, "GET", base + "/api/inquiries");
    assert.equal(inquiries.status, 200);
    assertNoA(inquiries.body);
    assert.match(JSON.stringify(inquiries.body), /B-INQ/);
    const rules = await call(routes.rules, "GET", base + "/api/recurring");
    assert.equal(rules.status, 200);
    assertNoA(rules.body);
    assert.match(JSON.stringify(rules.body), /B-RULE/);
    const push = await call(routes.push, "GET", base + "/api/push/subscribe?endpoint=" + encodeURIComponent(ids.pushA));
    assert.equal(push.status, 200);
    assert.equal((push.body as { subscribed: boolean }).subscribed, false);
    const before = snap(db);
    const attempts = [
      call(routes.inquiry, "PATCH", base + "/api/inquiries/" + ids.inquiryA, { params: { id: ids.inquiryA }, json: { action: "read" } }),
      call(routes.inquiry, "PATCH", base + "/api/inquiries/" + ids.inquiryA, { params: { id: ids.inquiryA }, json: { action: "convert" } }),
      call(routes.rule, "PATCH", base + "/api/recurring/" + ids.ruleA, { params: { id: ids.ruleA }, json: { action: "pause" } }),
      call(routes.rule, "PATCH", base + "/api/recurring/" + ids.ruleB, { params: { id: ids.ruleB }, json: { amountMinor: 800, category: "Comida", accountId: ids.accountA } }),
      call(routes.rule, "DELETE", base + "/api/recurring/" + ids.ruleA, { params: { id: ids.ruleA } }),
      call(routes.receipt, "GET", base + "/api/receipts/" + ids.receiptA, { params: { id: ids.receiptA } }),
      call(routes.receipt, "DELETE", base + "/api/receipts/" + ids.receiptA, { params: { id: ids.receiptA } }),
      call(routes.push, "DELETE", base + "/api/push/subscribe", { json: { endpoint: ids.pushA } }),
      call(routes.push, "POST", base + "/api/push/subscribe", { json: { endpoint: ids.pushA, keys: { p256dh: "C".repeat(87), auth: "D".repeat(22) } } }),
    ];
    for (const pending of attempts) {
      const res = await pending;
      assert4xx(res.status, res.body);
    }
    assertSame(db, before);
    const own = await call(routes.receipt, "GET", base + "/api/receipts/" + ids.receiptB, { params: { id: ids.receiptB } });
    assert.equal(own.status, 200);
  });
});

test("a phone that changes hands can take over its push endpoint only with the subscription keys", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const owner = () => (db.prepare("SELECT user_id AS u FROM push_subscriptions WHERE endpoint=?").get(ids.pushA) as { u: string }).u;
    const guess = await call(routes.push, "POST", base + "/api/push/subscribe", { json: { endpoint: ids.pushA, keys: { p256dh: "C".repeat(87), auth: "D".repeat(22) } } });
    assert.equal(guess.status, 409);
    assert.equal(owner(), A);
    const handover = await call(routes.push, "POST", base + "/api/push/subscribe", { json: { endpoint: ids.pushA, keys: { p256dh: P256, auth: PUSH_AUTH } } });
    assert.equal(handover.status, 200);
    assert.equal(owner(), B);
  });
});

function png(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], "ticket.png", { type: "image/png" });
}

test("a ticket over 1,4 MB is rejected and a smaller one is stored", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const scan = await import("../app/api/receipts/scan/route.ts");
    const count = () => Number((db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n);
    const before = count();
    const big = new FormData();
    big.set("file", png(1_450_000));
    const tooBig = await call(scan, "POST", base + "/api/receipts/scan", { form: big });
    assert.equal(tooBig.status, 413);
    assert.match(JSON.stringify(tooBig.body), /1,4 MB/);
    assert.equal(count(), before);
    const ok = new FormData();
    ok.set("file", png(1_000_000));
    const stored = await call(scan, "POST", base + "/api/receipts/scan", { form: ok });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.equal(typeof (stored.body as { receiptId?: string }).receiptId, "string");
    assert.equal(count(), before + 1);
    const row = db.prepare("SELECT user_id AS userId, length(data) AS n FROM receipts WHERE id=?").get((stored.body as { receiptId: string }).receiptId) as { userId: string; n: number };
    assert.equal(row.userId, B);
    assert.ok(row.n < 1_900_000);
  });
});
