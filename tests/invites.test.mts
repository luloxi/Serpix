import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { INVITE_TTL_MS, generateInvite, hashInviteCode, inviteStatus, listInvites, redeemInvite, revokeInvite } from "../lib/invites.ts";
import { getMaxUsers } from "../lib/settings.ts";
import { openDb } from "./db-helper.mts";

const NOW = Date.parse("2026-10-31T15:00:00.000Z");

function person(db: DatabaseSync, id: string, status = "approved", role = "user") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, NOW, NOW, role, status);
}

function inviteRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT code_hash, used_at, used_by, revoked_at, expires_at, note FROM invites WHERE id=?").get(id) as { code_hash: string; used_at: number | null; used_by: string | null; revoked_at: number | null; expires_at: number; note: string | null };
}

test("getMaxUsers reads app_settings and falls back to 5", async () => {
  const { db, d1 } = openDb();
  assert.equal(await getMaxUsers(d1), 5);
  db.prepare("UPDATE app_settings SET value='8' WHERE key='max_users'").run();
  assert.equal(await getMaxUsers(d1), 8);
  db.prepare("UPDATE app_settings SET value='nope' WHERE key='max_users'").run();
  assert.equal(await getMaxUsers(d1), 5);
  db.prepare("DELETE FROM app_settings WHERE key='max_users'").run();
  assert.equal(await getMaxUsers(d1), 5);
});

test("generateInvite stores only the sha-256 hash and expires in 7 days", async () => {
  const { db, d1 } = openDb();
  person(db, "admin", "approved", "admin");
  const created = await generateInvite(d1, "admin", NOW, "  para Ana  ");
  assert.match(created.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.expiresAt - NOW, INVITE_TTL_MS);
  const row = inviteRow(db, created.id);
  assert.equal(row.code_hash, await hashInviteCode(created.code));
  assert.equal(row.code_hash.length, 64);
  assert.notEqual(row.code_hash, created.code);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM invites").all()).includes(created.code), false);
  assert.equal(row.note, "para Ana");
  assert.equal(row.used_at, null);
  const listed = await listInvites(d1, NOW);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "pending");
  assert.equal(JSON.stringify(listed).includes(created.code), false);
  assert.equal(JSON.stringify(listed).includes(row.code_hash), false);
  assert.equal(inviteStatus({ used_at: null, revoked_at: null, expires_at: NOW + 1 }, NOW), "pending");
  assert.equal(inviteStatus({ used_at: NOW, revoked_at: null, expires_at: NOW - 1 }, NOW), "used");
  assert.equal(inviteStatus({ used_at: null, revoked_at: null, expires_at: NOW }, NOW), "expired");
  assert.equal(inviteStatus({ used_at: NOW, revoked_at: NOW, expires_at: NOW - 1 }, NOW), "revoked");
});

test("a valid redeem approves; the same code, an expired code, a revoked code and an unknown code do not", async () => {
  const { db, d1 } = openDb();
  person(db, "admin", "approved", "admin");
  person(db, "p1", "pending");
  person(db, "p2", "pending");
  const created = await generateInvite(d1, "admin", NOW);
  assert.equal((await redeemInvite(d1, "p1", created.code, created.expiresAt)).status, "expired");
  assert.equal(inviteRow(db, created.id).used_at, null);
  assert.equal((await redeemInvite(d1, "p1", created.code, created.expiresAt - 1)).status, "ok");
  assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='p1'").get() as { s: string }).s, "approved");
  assert.equal((await redeemInvite(d1, "p2", created.code, NOW + 10)).status, "used");
  assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='p2'").get() as { s: string }).s, "pending");
  db.prepare("UPDATE invites SET expires_at=? WHERE id=?").run(NOW - 1, created.id);
  assert.equal((await redeemInvite(d1, "p2", created.code, NOW)).status, "used");

  const revoked = await generateInvite(d1, "admin", NOW);
  assert.equal(await revokeInvite(d1, revoked.id, NOW), true);
  assert.equal((await redeemInvite(d1, "p2", revoked.code, NOW)).status, "revoked");
  assert.equal(inviteRow(db, revoked.id).used_at, null);
  assert.equal(await revokeInvite(d1, revoked.id, NOW), false);
  assert.equal(await revokeInvite(d1, "missing", NOW), false);
  assert.equal(await revokeInvite(d1, created.id, NOW), false);

  assert.equal((await redeemInvite(d1, "p2", "a".repeat(43), NOW)).status, "invalid");
  assert.equal((await redeemInvite(d1, "p2", "nope", NOW)).status, "invalid");
  const listed = await listInvites(d1, NOW);
  assert.equal(listed.find((item) => item.id === created.id)?.status, "used");
  assert.equal(listed.find((item) => item.id === revoked.id)?.status, "revoked");
});

test("a full cap does not consume the invite, and a rejected or already-approved user does not either", async () => {
  const { db, d1 } = openDb();
  person(db, "admin", "approved", "admin");
  person(db, "p1", "pending");
  person(db, "nope", "rejected");
  person(db, "old", "approved");
  db.prepare("UPDATE app_settings SET value='2' WHERE key='max_users'").run();
  const full = await generateInvite(d1, "admin", NOW);
  assert.equal((await redeemInvite(d1, "p1", full.code, NOW)).status, "full");
  assert.equal(inviteRow(db, full.id).used_at, null);
  assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id='p1'").get() as { s: string }).s, "pending");
  assert.equal((await listInvites(d1, NOW))[0].status, "pending");

  db.prepare("UPDATE app_settings SET value='5' WHERE key='max_users'").run();
  const kept = await generateInvite(d1, "admin", NOW);
  assert.equal((await redeemInvite(d1, "nope", kept.code, NOW)).status, "rejected");
  assert.equal(inviteRow(db, kept.id).used_at, null);
  assert.equal((await redeemInvite(d1, "old", kept.code, NOW)).status, "already_approved");
  assert.equal(inviteRow(db, kept.id).used_at, null);
  assert.equal((await redeemInvite(d1, "p1", kept.code, NOW)).status, "ok");
});

test("two concurrent redeems of one code let exactly one user in", async () => {
  const { db, d1 } = openDb();
  person(db, "admin", "approved", "admin");
  person(db, "p1", "pending");
  person(db, "p2", "pending");
  const created = await generateInvite(d1, "admin", NOW);
  const [a, b] = await Promise.all([
    redeemInvite(d1, "p1", created.code, NOW),
    redeemInvite(d1, "p2", created.code, NOW),
  ]);
  const oks = [a, b].filter((result) => result.status === "ok");
  assert.equal(oks.length, 1);
  assert.equal([a, b].filter((result) => result.status === "used").length, 1);
  const winner = a.status === "ok" ? "p1" : "p2";
  assert.equal(inviteRow(db, created.id).used_by, winner);
  const loser = winner === "p1" ? "p2" : "p1";
  assert.equal((db.prepare("SELECT approvalStatus AS s FROM user WHERE id=?").get(loser) as { s: string }).s, "pending");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user WHERE approvalStatus='approved'").get() as { n: number }).n, 2);
});

test("two concurrent redeems with one seat left approve exactly one and leave the other invite", async () => {
  const { db, d1 } = openDb();
  person(db, "admin", "approved", "admin");
  person(db, "p1", "pending");
  person(db, "p2", "pending");
  db.prepare("UPDATE app_settings SET value='2' WHERE key='max_users'").run();
  const first = await generateInvite(d1, "admin", NOW);
  const second = await generateInvite(d1, "admin", NOW);
  const [a, b] = await Promise.all([
    redeemInvite(d1, "p1", first.code, NOW),
    redeemInvite(d1, "p2", second.code, NOW),
  ]);
  assert.equal([a, b].filter((result) => result.status === "ok").length, 1);
  assert.equal([a, b].filter((result) => result.status === "full").length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user WHERE approvalStatus='approved'").get() as { n: number }).n, 2);
  const unused = [first, second].filter((item) => inviteRow(db, item.id).used_at == null);
  assert.equal(unused.length, 1);
});

test("batch rolls back the first statement when the second fails", async () => {
  const { db, d1 } = openDb();
  const insert = d1.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?,?,?,?)").bind("d", "s", "k", 5);
  const boom = d1.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?,?,?,?)").bind("d", "s", "k", 9);
  await assert.rejects(() => d1.batch!([insert, boom]));
  assert.equal(db.prepare("SELECT amount FROM usage_daily WHERE day='d'").get(), undefined);
});
