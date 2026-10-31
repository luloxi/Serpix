import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { AI_CUTOFF_NEURONS, AI_DISABLED_MESSAGE, AI_GLOBAL_LIMIT_MESSAGE, NEURONS_PER_SCAN_ESTIMATE, SCAN_LIMIT_MESSAGE, utcDay } from "../lib/ai-quota.ts";
import { generateInvite, hashInviteCode, redeemInvite } from "../lib/invites.ts";
import { todayInBuenosAires } from "../lib/recurring.ts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { openDb } from "./db-helper.mts";

const base = "http://t.local";

function person(db: DatabaseSync, id: string, status = "approved", role = "user") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, 1, 1, role, status);
}

function png(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], "ticket.png", { type: "image/png" });
}

function form() {
  const body = new FormData();
  body.set("file", png());
  return body;
}

function usage(db: DatabaseSync, day: string, scope: string, kind: string) {
  const row = db.prepare("SELECT amount FROM usage_daily WHERE day=? AND scope=? AND kind=?").get(day, scope, kind) as { amount: number } | undefined;
  return row?.amount ?? 0;
}

function spyAi(reply: unknown = { response: "" }) {
  const env = globalThis.__testEnv as { AI: { run: (...args: unknown[]) => Promise<unknown> } };
  const calls: unknown[] = [];
  env.AI.run = async (...args: unknown[]) => {
    calls.push(args);
    return reply;
  };
  return calls;
}

async function routes() {
  return {
    invites: await import("../app/api/admin/invites/route.ts"),
    invite: await import("../app/api/admin/invites/[id]/route.ts"),
    redeem: await import("../app/api/invites/redeem/route.ts"),
    users: await import("../app/api/admin/users/route.ts"),
    user: await import("../app/api/admin/users/[userId]/route.ts"),
    scan: await import("../app/api/receipts/scan/route.ts"),
  };
}

test("invite routes: no session is 401, a non-admin is 403, create is paused, and revoke still works", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    person(db, "luciano", "approved", "admin");
    person(db, "beto", "approved", "user");
    person(db, "espera", "pending");
    setEnv(d1);
    const api = await routes();
    asUser(null);
    for (const hit of [
      call(api.invites, "GET", base + "/api/admin/invites"),
      call(api.invites, "POST", base + "/api/admin/invites", { json: {} }),
      call(api.invite, "DELETE", base + "/api/admin/invites/x", { params: { id: "x" } }),
      call(api.redeem, "POST", base + "/api/invites/redeem", { json: { code: "a".repeat(43) } }),
    ]) {
      assert.equal((await hit).status, 401);
    }
    asUser("espera", "user", "pending");
    const pendingPost = await call(api.invites, "POST", base + "/api/admin/invites", { json: { note: "para Beto" } });
    assert.equal(pendingPost.status, 401);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n, 0);

    asUser("luciano", "admin");
    const paused = await call(api.invites, "POST", base + "/api/admin/invites", { json: { note: "para Beto" } });
    assert.equal(paused.status, 423, JSON.stringify(paused.body));
    assert.deepEqual(paused.body, { error: "Las invitaciones están pausadas por ahora." });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n, 0);
    const empty = await call(api.invites, "GET", base + "/api/admin/invites");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { invites: [], enabled: false });

    const created = await generateInvite(d1, "luciano", Date.now(), "para Beto", { enabled: true });
    const dumped = JSON.stringify(db.prepare("SELECT * FROM invites").all());
    assert.equal(dumped.includes(created.code), false);
    assert.equal(dumped.includes(await hashInviteCode(created.code)), true);
    const listed = await call(api.invites, "GET", base + "/api/admin/invites");
    assert.equal(listed.status, 200);
    const body = listed.body as { enabled: boolean; invites: { id: string; status: string; note: string }[] };
    assert.equal(body.enabled, false);
    assert.equal(body.invites[0].id, created.id);
    assert.equal(body.invites[0].status, "pending");
    assert.equal(body.invites[0].note, "para Beto");
    assert.equal(JSON.stringify(listed.body).includes(created.code), false);
    assert.equal(JSON.stringify(listed.body).includes("code_hash"), false);

    asUser("beto", "user", "approved");
    const seen = await call(api.invites, "GET", base + "/api/admin/invites");
    assert.equal(seen.status, 403);
    assert.deepEqual(seen.body, { error: "Forbidden" });
    const blocked = await call(api.invite, "DELETE", base + "/api/admin/invites/" + created.id, { params: { id: created.id } });
    assert.equal(blocked.status, 403);
    assert.equal((db.prepare("SELECT revoked_at AS r FROM invites WHERE id=?").get(created.id) as { r: number | null }).r, null);
    const forged = await call(api.invites, "POST", base + "/api/admin/invites", { json: {} });
    assert.equal(forged.status, 403);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n, 1);

    asUser("luciano", "admin");
    const gone = await call(api.invite, "DELETE", base + "/api/admin/invites/" + created.id, { params: { id: created.id } });
    assert.equal(gone.status, 200);
    const again = await call(api.invite, "DELETE", base + "/api/admin/invites/" + created.id, { params: { id: created.id } });
    assert.equal(again.status, 404);
    const missing = await call(api.invite, "DELETE", base + "/api/admin/invites/nope", { params: { id: "nope" } });
    assert.equal(missing.status, 404);
  });
});

test("a paused redeem leaves the invite unused and an enabled redeem still accepts it", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    person(db, "luciano", "approved", "admin");
    person(db, "nuevo", "pending");
    setEnv(d1);
    const api = await routes();
    const created = await generateInvite(d1, "luciano", Date.now(), undefined, { enabled: true });
    asUser(null);
    const anon = await call(api.redeem, "POST", base + "/api/invites/redeem", { json: { code: created.code } });
    assert.equal(anon.status, 401);
    assert.equal((db.prepare("SELECT used_at AS u FROM invites").get() as { u: number | null }).u, null);
    asUser("nuevo", "user", "pending");
    const paused = await call(api.redeem, "POST", base + "/api/invites/redeem", { json: { code: created.code } });
    assert.equal(paused.status, 423);
    assert.deepEqual(paused.body, { status: "disabled" });
    assert.equal((db.prepare("SELECT used_at AS u, used_by AS b FROM invites").get() as { u: number | null; b: string | null }).u, null);
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='nuevo'").get() as { s: string }).s, "pending");
    const ok = await redeemInvite(d1, "nuevo", created.code, Date.now(), { enabled: true });
    assert.deepEqual(ok, { status: "ok" });
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='nuevo'").get() as { s: string }).s, "approved");
    assert.equal((db.prepare("SELECT used_by AS b FROM invites").get() as { b: string | null }).b, "nuevo");
    const again = await call(api.redeem, "POST", base + "/api/invites/redeem", { json: { code: created.code } });
    assert.equal(again.status, 423);
    assert.deepEqual(again.body, { status: "disabled" });
    assert.equal((db.prepare("SELECT used_by AS b FROM invites").get() as { b: string | null }).b, "nuevo");
  });
});

test("manual approval hits the cap, re-approving is a no-op, and rejection still drops the session", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    person(db, "luciano", "approved", "admin");
    person(db, "ya", "approved");
    person(db, "nuevo", "pending");
    db.prepare("INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', 9999999999999, 'tok-nuevo', 1, 1, 'nuevo')").run();
    db.prepare("UPDATE app_settings SET value='2' WHERE key='max_users'").run();
    const stamp = (db.prepare("SELECT updatedAt AS t FROM user WHERE id='ya'").get() as { t: number }).t;
    setEnv(d1);
    const api = await routes();
    asUser("beto", "user");
    const forbidden = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { approvalStatus: "approved" } });
    assert.equal(forbidden.status, 403);
    asUser("luciano", "admin");
    const capped = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { approvalStatus: "approved" } });
    assert.equal(capped.status, 409);
    assert.deepEqual(capped.body, { error: "Alcanzaste el tope de 2 usuarios." });
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='nuevo'").get() as { s: string }).s, "pending");
    const noop = await call(api.user, "PATCH", base + "/api/admin/users/ya", { params: { userId: "ya" }, json: { approvalStatus: "approved" } });
    assert.equal(noop.status, 200);
    assert.equal((db.prepare("SELECT updatedAt AS t FROM user WHERE id='ya'").get() as { t: number }).t, stamp);
    const rejected = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { approvalStatus: "rejected" } });
    assert.equal(rejected.status, 200);
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='nuevo'").get() as { s: string }).s, "rejected");
    assert.equal(db.prepare("SELECT id FROM session WHERE userId='nuevo'").get(), undefined);
    db.prepare("UPDATE app_settings SET value='3' WHERE key='max_users'").run();
    person(db, "otro", "pending");
    const allowed = await call(api.user, "PATCH", base + "/api/admin/users/otro", { params: { userId: "otro" }, json: { approvalStatus: "approved" } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='otro'").get() as { s: string }).s, "approved");
  });
});

test("the admin can toggle AI receipts for a non-admin and the list reports the flag", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    person(db, "luciano", "approved", "admin");
    person(db, "otro", "approved", "admin");
    person(db, "nuevo", "pending");
    setEnv(d1);
    const api = await routes();
    asUser("luciano", "admin");
    const listed = await call(api.users, "GET", base + "/api/admin/users");
    const users = (listed.body as { users: { id: string; aiReceipts: boolean; role: string }[] }).users;
    assert.equal(users.find((user) => user.id === "nuevo")?.aiReceipts, false);
    const on = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { aiReceipts: true } });
    assert.equal(on.status, 200);
    assert.equal((db.prepare("SELECT ai_receipts_enabled AS f FROM user WHERE id='nuevo'").get() as { f: number }).f, 1);
    assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='nuevo'").get() as { s: string }).s, "pending");
    const off = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { aiReceipts: false } });
    assert.equal(off.status, 200);
    assert.equal((db.prepare("SELECT ai_receipts_enabled AS f FROM user WHERE id='nuevo'").get() as { f: number }).f, 0);
    const adminTarget = await call(api.user, "PATCH", base + "/api/admin/users/otro", { params: { userId: "otro" }, json: { aiReceipts: true } });
    assert.equal(adminTarget.status, 404);
    const missing = await call(api.user, "PATCH", base + "/api/admin/users/nadie", { params: { userId: "nadie" }, json: { aiReceipts: true } });
    assert.equal(missing.status, 404);
    asUser("nuevo", "user", "pending");
    const forbidden = await call(api.user, "PATCH", base + "/api/admin/users/luciano", { params: { userId: "luciano" }, json: { aiReceipts: false } });
    assert.equal(forbidden.status, 401);
    asUser("otro", "user", "approved");
    const also = await call(api.user, "PATCH", base + "/api/admin/users/nuevo", { params: { userId: "nuevo" }, json: { aiReceipts: true } });
    assert.equal(also.status, 403);
    assert.equal((db.prepare("SELECT ai_receipts_enabled AS f FROM user WHERE id='nuevo'").get() as { f: number }).f, 0);
  });
});

test("scan quotas: admin keeps AI, invitees need the flag, and both caps store or refuse as specified", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    person(db, "luciano", "approved", "admin");
    person(db, "ana", "approved");
    setEnv(d1);
    const calls = spyAi();
    const api = await routes();
    const day = todayInBuenosAires(Date.now());
    const utc = utcDay(Date.now());

    asUser("luciano", "admin");
    const adminScan = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(adminScan.status, 201, JSON.stringify(adminScan.body));
    assert.equal(calls.length, 1);
    assert.equal((adminScan.body as { ok: boolean }).ok, false);
    assert.equal(usage(db, day, "luciano", "receipt_scans"), 1);
    assert.equal(usage(db, utc, "global", "ai_neurons"), NEURONS_PER_SCAN_ESTIMATE);
    db.prepare("UPDATE user SET ai_receipts_enabled=0 WHERE id='luciano'").run();
    const still = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(still.status, 201);
    assert.equal(calls.length, 2);

    asUser("ana");
    const disabled = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(disabled.status, 201);
    assert.equal((disabled.body as { ok: boolean; aiStatus?: string; message?: string }).ok, false);
    assert.equal((disabled.body as { aiStatus?: string }).aiStatus, "disabled");
    assert.equal((disabled.body as { message?: string }).message, AI_DISABLED_MESSAGE);
    assert.equal(calls.length, 2);
    assert.equal(usage(db, day, "ana", "receipt_scans"), 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE user_id='ana'").get() as { n: number }).n, 1);

    db.prepare("UPDATE user SET ai_receipts_enabled=1 WHERE id='ana'").run();
    db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, 'ana', 'receipt_scans', 10)").run(day);
    const limited = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: SCAN_LIMIT_MESSAGE });
    assert.equal(calls.length, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE user_id='ana'").get() as { n: number }).n, 1);
    assert.equal(usage(db, day, "ana", "receipt_scans"), 10);

    db.prepare("UPDATE usage_daily SET amount=9 WHERE day=? AND scope='ana' AND kind='receipt_scans'").run(day);
    const tenth = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(tenth.status, 201, JSON.stringify(tenth.body));
    assert.equal(calls.length, 3);
    assert.equal(usage(db, day, "ana", "receipt_scans"), 10);

    db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, 'luciano', 'receipt_scans', 10) ON CONFLICT(day, scope, kind) DO UPDATE SET amount=10").run(day);
    asUser("luciano", "admin");
    const adminEleventh = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(adminEleventh.status, 201, JSON.stringify(adminEleventh.body));
    assert.equal(calls.length, 4);
    db.prepare("UPDATE usage_daily SET amount=60 WHERE day=? AND scope='luciano' AND kind='receipt_scans'").run(day);
    const adminSixtyFirst = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(adminSixtyFirst.status, 429);
    assert.equal(calls.length, 4);

    db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, 'global', 'ai_neurons', ?) ON CONFLICT(day, scope, kind) DO UPDATE SET amount=excluded.amount").run(utc, AI_CUTOFF_NEURONS);
    db.prepare("UPDATE usage_daily SET amount=0 WHERE day=? AND scope='ana' AND kind='receipt_scans'").run(day);
    asUser("ana");
    const global = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(global.status, 201, JSON.stringify(global.body));
    assert.equal((global.body as { aiStatus?: string }).aiStatus, "global_limit");
    assert.equal((global.body as { message?: string }).message, AI_GLOBAL_LIMIT_MESSAGE);
    assert.equal(calls.length, 4);
    assert.equal(usage(db, utc, "global", "ai_neurons"), AI_CUTOFF_NEURONS);
    assert.equal(usage(db, day, "ana", "receipt_scans"), 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE user_id='ana'").get() as { n: number }).n, 3);

    db.prepare("UPDATE usage_daily SET amount=0 WHERE day=? AND scope='global' AND kind='ai_neurons'").run(utc);
    setEnv(d1, { AI: undefined });
    const skipped = await call(api.scan, "POST", base + "/api/receipts/scan", { form: form() });
    assert.equal(skipped.status, 201);
    assert.equal((skipped.body as { ok: boolean; aiStatus?: string }).ok, false);
    assert.equal((skipped.body as { aiStatus?: string }).aiStatus, undefined);
    assert.equal(usage(db, utc, "global", "ai_neurons"), 0);
    assert.equal(usage(db, day, "ana", "receipt_scans"), 0);
  });
});
