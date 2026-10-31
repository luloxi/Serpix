import test from "node:test";
import assert from "node:assert/strict";
import { openDb, user } from "./db-helper.mts";
import {
  ADMIN_E2E_ERROR,
  BAD_COLLECTION,
  BAD_DOC,
  BAD_ID,
  BAD_JSON,
  BAD_QUERY,
  BLOB_TOO_BIG_ERROR,
  CANNOT_DELETE_LAST,
  CANNOT_DELETE_PASSWORD,
  DOC_ONLY_ERROR,
  ENVELOPE_ERROR,
  FIRST_WRAP_ERROR,
  ID_IN_USE,
  MAX_BLOB_CHARS,
  MAX_ROWS_PER_COLLECTION,
  PASSWORD_EXISTS_ERROR,
  RECORD_LIMIT_ERROR,
  REPLACE_PASSWORD_ONLY,
  TOMBSTONE_BLOB,
  WRAP_ERROR,
  WRAP_LIMIT_ERROR,
  WRAP_NOT_FOUND,
  addWrap,
  deleteWrap,
  encryptionMode,
  httpError,
  listKeys,
  listRecords,
  nextCounter,
  parseCounterBody,
  parseListQuery,
  parseRecordDelete,
  parseRecordWrite,
  parseTouch,
  parseWrapCreate,
  parseWrapReplace,
  replacePasswordWrap,
  storedWrap,
  tombstoneRecord,
  touchWrap,
  upsertRecord,
  validCollection,
  validRecordId,
  validateEnvelope,
  validateWrap,
  type KeyWrap,
} from "../lib/e2e-server.ts";

const NONCE = "a".repeat(16);
const CIPHER = "b".repeat(22);
const BLOB = JSON.stringify({ v: 1, n: NONCE, c: CIPHER });

function passwordWrap(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: "password", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), m: 65536, t: 3, p: 1, argonSalt: "r".repeat(22), ...extra };
}

function passkeyWrap(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: "passkey", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), prfSalt: "p".repeat(43), ...extra };
}

const DOC = { type: "invoice" as const, number: 7, status: "sent" as const, dueDate: "2026-11-02" };

test("envelope shape accepts only v, n and c", () => {
  assert.deepEqual(validateEnvelope(BLOB), { ok: true });
  assert.equal(validateEnvelope(1).ok, false);
  assert.equal(validateEnvelope("nope").status, 400);
  assert.equal(validateEnvelope("[]").status, 400);
  assert.equal(validateEnvelope(JSON.stringify({ v: 1, n: NONCE, c: CIPHER, plain: "x" })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ name: "Ana", email: "a@b.c" })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ v: 2, n: NONCE, c: CIPHER })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ v: 1, n: "short", c: CIPHER })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ v: 1, n: NONCE, c: "b".repeat(21) })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ v: 1, n: NONCE, c: "b".repeat(25) })).error, ENVELOPE_ERROR);
  assert.equal(validateEnvelope(JSON.stringify({ v: 1, n: NONCE + "+", c: CIPHER })).error, ENVELOPE_ERROR);
  const huge = "x".repeat(MAX_BLOB_CHARS + 1);
  const big = validateEnvelope(huge);
  assert.equal(big.ok, false);
  if (!big.ok) {
    assert.equal(big.status, 413);
    assert.equal(big.error, BLOB_TOO_BIG_ERROR);
  }
});

test("wrap shape checks lengths, exact keys and argon2 bounds", () => {
  const password = validateWrap(passwordWrap(), "password");
  assert.equal(password.ok, true);
  const passkey = validateWrap(passkeyWrap(), "passkey");
  assert.equal(passkey.ok, true);
  assert.equal(validateWrap(passwordWrap(), "passkey").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ note: "x" }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ m: 19455 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ m: 19456 }), "password").ok, true);
  assert.equal(validateWrap(passwordWrap({ m: 262144 }), "password").ok, true);
  assert.equal(validateWrap(passwordWrap({ m: 262145 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ m: 65536.5 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ t: 0 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ t: 11 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ t: "3" }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ p: 0 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ p: 5 }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ p: 1 }), "password").ok, true);
  assert.equal(validateWrap(passwordWrap({ p: 4 }), "password").ok, true);
  assert.equal(validateWrap(passwordWrap({ argonSalt: "r".repeat(21) }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ salt: "s".repeat(42) }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passwordWrap({ c: "c".repeat(63) }), "password").error, WRAP_ERROR);
  assert.equal(validateWrap(passkeyWrap({ prfSalt: "p".repeat(42) }), "passkey").error, WRAP_ERROR);
  assert.equal(validateWrap(null, "password").error, WRAP_ERROR);
  assert.equal(validRecordId("doc:1.2_a-b"), true);
  assert.equal(validRecordId(""), false);
  assert.equal(validRecordId("a".repeat(121)), false);
  assert.equal(validRecordId("a b"), false);
  assert.equal(validCollection("contacts"), true);
  assert.equal(validCollection("inquiries"), false);
});

test("parsers reject the shapes the routes must not store", () => {
  const write = parseRecordWrite("contacts", "c1", { expectedVersion: 0, blob: BLOB });
  assert.equal(write.ok, true);
  assert.equal(parseRecordWrite("inquiries", "c1", { expectedVersion: 0, blob: BLOB }).error, BAD_COLLECTION);
  assert.equal(parseRecordWrite("contacts", "bad id", { expectedVersion: 0, blob: BLOB }).error, BAD_ID);
  assert.equal(parseRecordWrite("contacts", "c1", { expectedVersion: 0, blob: BLOB, doc: DOC }).error, DOC_ONLY_ERROR);
  assert.equal(parseRecordWrite("contacts", "c1", { expectedVersion: 0, blob: BLOB, note: 1 }).error, BAD_JSON);
  assert.equal(parseRecordWrite("contacts", "c1", { expectedVersion: -1, blob: BLOB }).error, BAD_JSON);
  assert.equal(parseRecordWrite("contacts", "c1", { expectedVersion: 1.5, blob: BLOB }).error, BAD_JSON);
  assert.equal(parseRecordWrite("contacts", "c1", { expectedVersion: 0, blob: { v: 1 } }).error, ENVELOPE_ERROR);
  assert.equal(parseRecordWrite("contacts", "c1", null).error, BAD_JSON);
  const doc = parseRecordWrite("documents", "d1", { expectedVersion: 0, blob: BLOB, doc: DOC });
  assert.equal(doc.ok, true);
  if (doc.ok) assert.equal(doc.doc?.number, 7);
  assert.equal(parseRecordWrite("documents", "d1", { expectedVersion: 0, blob: BLOB, doc: { ...DOC, dueDate: null } }).ok, true);
  assert.equal(parseRecordWrite("documents", "d1", { expectedVersion: 0, blob: BLOB, doc: { ...DOC, status: "open" } }).error, BAD_DOC);
  assert.equal(parseRecordWrite("documents", "d1", { expectedVersion: 0, blob: BLOB, doc: { ...DOC, number: 0 } }).error, BAD_DOC);
  assert.equal(parseRecordWrite("documents", "d1", { expectedVersion: 0, blob: BLOB, doc: { type: "invoice" } }).error, BAD_DOC);
  assert.equal(parseRecordDelete({ expectedVersion: 2 }).ok, true);
  assert.equal(parseRecordDelete({ expectedVersion: 2, blob: BLOB }).error, BAD_JSON);
  assert.equal(parseListQuery(null, null, null).ok, true);
  assert.equal(parseListQuery("contacts", "0", "1").ok, true);
  assert.equal(parseListQuery("inquiries", "0", "1").error, BAD_COLLECTION);
  assert.equal(parseListQuery(null, "-1", "1").error, BAD_QUERY);
  assert.equal(parseListQuery(null, "01", "1").error, BAD_QUERY);
  assert.equal(parseListQuery(null, "1", "0").error, BAD_QUERY);
  assert.equal(parseListQuery(null, "1", "501").error, BAD_QUERY);
  assert.equal(parseCounterBody({ kind: "quote" }).ok, true);
  assert.equal(parseCounterBody({ kind: "invoice" }).ok, true);
  assert.equal(parseCounterBody({ kind: "seq" }).error, BAD_JSON);
  assert.equal(parseCounterBody({ kind: "quote", n: 1 }).error, BAD_JSON);
  assert.equal(parseWrapCreate({ type: "password", wrap: passwordWrap() }).ok, true);
  assert.equal(parseWrapCreate({ type: "password", wrap: passwordWrap(), credentialId: "abc" }).error, "La contraseña no lleva credencial");
  assert.equal(parseWrapCreate({ type: "nope", wrap: {} }).error, BAD_JSON);
  assert.equal(parseWrapCreate({ type: "passkey", wrap: [] }).error, WRAP_ERROR);
  assert.equal(parseWrapReplace({ wrap: passwordWrap() }).ok, true);
  assert.equal(parseWrapReplace({ wrap: passwordWrap(), id: "x" }).error, BAD_JSON);
  assert.equal(parseTouch({ touch: true }).ok, true);
  assert.equal(parseTouch({ touch: false }).error, BAD_JSON);
  assert.deepEqual(httpError({ ok: false, status: 409, currentVersion: 4 }), { status: 409, body: { currentVersion: 4 } });
  assert.deepEqual(httpError({ ok: false, status: 409, error: RECORD_LIMIT_ERROR }), { status: 409, body: { error: RECORD_LIMIT_ERROR } });
});

test("stored wrap is canonical and the first password wrap switches the mode", async () => {
  const validated = validateWrap(passwordWrap(), "password");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const canonical = storedWrap(validated.wrap);
  assert.equal(canonical, JSON.stringify(validated.wrap));
  assert.equal(canonical.includes("plain"), false);

  const { db, d1 } = openDb();
  user(db, "ana");
  user(db, "beto");
  user(db, "root");
  db.prepare("UPDATE user SET role='admin' WHERE id=?").run("root");
  assert.equal(await encryptionMode(d1, "ana"), "server");
  assert.equal((await addWrap(d1, "root", { id: "admin-wrap", type: "password", wrap: passwordWrap(), credentialId: null }, 1)).error, ADMIN_E2E_ERROR);
  assert.equal(await encryptionMode(d1, "root"), "server");
  assert.equal((await addWrap(d1, "ana", { id: "pk", type: "passkey", wrap: passkeyWrap(), credentialId: "cred" }, 1)).error, FIRST_WRAP_ERROR);
  assert.equal(await encryptionMode(d1, "ana"), "server");

  db.prepare("INSERT INTO user_keys (id,user_id,type,wrap,created_at) VALUES ('taken','beto','passkey','{}',1)").run();
  const collided = await addWrap(d1, "ana", { id: "taken", type: "password", wrap: passwordWrap(), credentialId: null }, 2);
  assert.equal(collided.error, ID_IN_USE);
  assert.equal(await encryptionMode(d1, "ana"), "server");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id='ana'").get() as { n: number }).n, 0);

  const created = await addWrap(d1, "ana", { id: "pw", type: "password", wrap: passwordWrap(), credentialId: null }, 3);
  assert.deepEqual(created, { ok: true, id: "pw" });
  assert.equal(await encryptionMode(d1, "ana"), "e2e");
  assert.equal((await addWrap(d1, "ana", { id: "pw2", type: "password", wrap: passwordWrap(), credentialId: null }, 4)).error, PASSWORD_EXISTS_ERROR);
  for (let i = 0; i < 4; i++) {
    const added = await addWrap(d1, "ana", { id: "k" + i, type: "passkey", wrap: passkeyWrap(), credentialId: "c" + i }, 5 + i);
    assert.equal(added.ok, true, JSON.stringify(added));
  }
  assert.equal((await addWrap(d1, "ana", { id: "k9", type: "passkey", wrap: passkeyWrap(), credentialId: "c9" }, 20)).error, WRAP_LIMIT_ERROR);

  const listed = await listKeys(d1, "ana");
  assert.equal(listed.mode, "e2e");
  assert.equal(listed.wraps.length, 5);
  assert.equal(listed.wraps[0].id, "pw");
  assert.equal((listed.wraps[0].wrap as KeyWrap).type, "password");
  assert.equal(listed.wraps[0].lastUsedAt, null);
  assert.equal((await listKeys(d1, "beto")).mode, "server");

  assert.equal((await replacePasswordWrap(d1, "beto", "pw", passwordWrap({ m: 19456 }))).error, WRAP_NOT_FOUND);
  assert.equal((await replacePasswordWrap(d1, "ana", "k0", passwordWrap())).error, REPLACE_PASSWORD_ONLY);
  assert.equal((await replacePasswordWrap(d1, "ana", "pw", passwordWrap({ m: 19456 }))).ok, true);
  const replaced = await listKeys(d1, "ana");
  assert.equal((replaced.wraps[0].wrap as { m: number }).m, 19456);
  assert.equal((await touchWrap(d1, "beto", "pw", 99)).error, WRAP_NOT_FOUND);
  assert.equal((await touchWrap(d1, "ana", "pw", 99)).ok, true);
  assert.equal((await listKeys(d1, "ana")).wraps[0].lastUsedAt, 99);
  assert.equal((await deleteWrap(d1, "ana", "pw")).error, CANNOT_DELETE_PASSWORD);
  assert.equal((await deleteWrap(d1, "beto", "pw")).error, WRAP_NOT_FOUND);
  assert.equal((await deleteWrap(d1, "ana", "k0")).ok, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id='ana'").get() as { n: number }).n, 4);

  db.prepare("INSERT INTO user_keys (id,user_id,type,wrap,created_at) VALUES ('solo','beto','passkey','{}',1)").run();
  db.prepare("DELETE FROM user_keys WHERE user_id='beto' AND id='taken'").run();
  assert.equal((await deleteWrap(d1, "beto", "solo")).error, CANNOT_DELETE_LAST);
});

test("two first wraps leave a single password wrap and the mode e2e", async () => {
  const { db, d1 } = openDb();
  user(db, "ana");
  const [a, b] = await Promise.all([
    addWrap(d1, "ana", { id: "one", type: "password", wrap: passwordWrap(), credentialId: null }, 1),
    addWrap(d1, "ana", { id: "two", type: "password", wrap: passwordWrap(), credentialId: null }, 2),
  ]);
  const wins = [a, b].filter((row) => row.ok);
  assert.equal(wins.length, 1);
  assert.equal(await encryptionMode(d1, "ana"), "e2e");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id='ana'").get() as { n: number }).n, 1);
});

test("records: concurrency, doc columns, tombstones, listing and the row cap", async () => {
  const { db, d1 } = openDb();
  user(db, "ana");
  user(db, "beto");
  const input = { expectedVersion: 0, blob: BLOB, hasDoc: false, doc: null };
  const created = await upsertRecord(d1, "ana", "contacts", "c1", input, 10);
  assert.deepEqual(created, { ok: true, seq: 1, version: 1, created: true });
  const again = await upsertRecord(d1, "ana", "contacts", "c1", input, 11);
  assert.deepEqual(again, { ok: false, status: 409, currentVersion: 1 });
  assert.equal((db.prepare("SELECT value FROM e2e_counters WHERE user_id='ana' AND kind='seq'").get() as { value: number }).value, 1);

  const doc = await upsertRecord(d1, "ana", "documents", "d1", { expectedVersion: 0, blob: BLOB, hasDoc: true, doc: DOC }, 12);
  assert.equal(doc.ok, true);
  const kept = await upsertRecord(d1, "ana", "documents", "d1", { expectedVersion: 1, blob: BLOB, hasDoc: false, doc: null }, 13);
  assert.equal(kept.ok, true);
  const row = db.prepare("SELECT version, doc_type, doc_number, doc_status, doc_due_date, deleted FROM records WHERE id='d1'").get() as { version: number; doc_type: string; doc_number: number; doc_status: string; doc_due_date: string; deleted: number };
  assert.equal(row.version, 2);
  assert.equal(row.doc_type, "invoice");
  assert.equal(row.doc_number, 7);
  assert.equal(row.doc_due_date, "2026-11-02");
  assert.equal(row.deleted, 0);

  const stale = await upsertRecord(d1, "ana", "documents", "d1", { expectedVersion: 1, blob: BLOB, hasDoc: false, doc: null }, 14);
  assert.deepEqual(stale, { ok: false, status: 409, currentVersion: 2 });
  const missing = await upsertRecord(d1, "ana", "contacts", "nope", { expectedVersion: 3, blob: BLOB, hasDoc: false, doc: null }, 15);
  assert.deepEqual(missing, { ok: false, status: 409, currentVersion: 0 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM records WHERE id='nope'").get() as { n: number }).n, 0);

  const tomb = await tombstoneRecord(d1, "ana", "contacts", "c1", 1, 16);
  assert.equal(tomb.ok, true);
  if (tomb.ok) assert.equal(tomb.version, 2);
  const dead = db.prepare("SELECT version, deleted, blob, seq FROM records WHERE user_id='ana' AND id='c1'").get() as { version: number; deleted: number; blob: string; seq: number };
  assert.equal(dead.deleted, 1);
  assert.equal(dead.blob, TOMBSTONE_BLOB);
  assert.equal(dead.version, 2);
  const retomb = await tombstoneRecord(d1, "ana", "contacts", "c1", 1, 17);
  assert.deepEqual(retomb, { ok: false, status: 409, currentVersion: 2 });
  assert.equal((await tombstoneRecord(d1, "ana", "contacts", "gone", 1, 18)).status, 404);
  const cross = await upsertRecord(d1, "beto", "contacts", "c1", { expectedVersion: 2, blob: BLOB, hasDoc: false, doc: null }, 19);
  assert.deepEqual(cross, { ok: false, status: 409, currentVersion: 0 });
  assert.equal((db.prepare("SELECT blob FROM records WHERE user_id='ana' AND id='c1'").get() as { blob: string }).blob, TOMBSTONE_BLOB);
  assert.equal((await tombstoneRecord(d1, "beto", "contacts", "c1", 2, 20)).status, 404);

  const third = await upsertRecord(d1, "ana", "tasks", "t1", input, 21);
  assert.equal(third.ok, true);
  const page = await listRecords(d1, "ana", { collection: null, since: 0, limit: 2 });
  assert.equal(page.records.length, 2);
  assert.equal(page.more, true);
  assert.equal(page.cursor, page.records[1].seq);
  const rest = await listRecords(d1, "ana", { collection: null, since: page.cursor, limit: 2 });
  assert.equal(rest.more, false);
  assert.equal(rest.records.length, 1);
  const only = await listRecords(d1, "ana", { collection: "tasks", since: 0, limit: 10 });
  assert.deepEqual(only.records.map((item) => item.id), ["t1"]);
  assert.equal(only.records[0].deleted, false);
  const tombView = (await listRecords(d1, "ana", { collection: "contacts", since: 0, limit: 10 })).records[0];
  assert.equal(tombView.deleted, true);
  assert.equal(tombView.blob, TOMBSTONE_BLOB);
  const empty = await listRecords(d1, "ana", { collection: null, since: 999, limit: 10 });
  assert.equal(empty.cursor, 999);
  assert.deepEqual(empty.records, []);
  assert.equal((await listRecords(d1, "beto", { collection: null, since: 0, limit: 10 })).records.length, 0);

  const seqBefore = (db.prepare("SELECT value FROM e2e_counters WHERE user_id='ana' AND kind='seq'").get() as { value: number }).value;
  const parallel = await Promise.all(Array.from({ length: 20 }, (_, i) => upsertRecord(d1, "ana", "projects", "p" + i, input, 30)));
  const seqs = parallel.map((item) => (item.ok ? item.seq : 0)).sort((a, b) => a - b);
  assert.equal(parallel.every((item) => item.ok), true);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => seqBefore + 1 + i));

  const [win, lose] = await Promise.all([
    upsertRecord(d1, "ana", "tasks", "t1", { expectedVersion: 1, blob: BLOB, hasDoc: false, doc: null }, 40),
    upsertRecord(d1, "ana", "tasks", "t1", { expectedVersion: 1, blob: BLOB, hasDoc: false, doc: null }, 41),
  ]);
  assert.equal([win, lose].filter((item) => item.ok).length, 1);
  assert.equal([win, lose].filter((item) => !item.ok).length, 1);
  assert.equal((db.prepare("SELECT version FROM records WHERE user_id='ana' AND collection='tasks' AND id='t1'").get() as { version: number }).version, 2);

  const quotes = await Promise.all(Array.from({ length: 50 }, () => nextCounter(d1, "ana", "quote")));
  assert.deepEqual([...quotes].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(await nextCounter(d1, "ana", "invoice"), 1);
  assert.equal(await nextCounter(d1, "beto", "quote"), 1);

  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO records (user_id,collection,id,seq,version,blob,created_at,updated_at,deleted) VALUES ('ana','avatars',?,1,1,?,1,1,0)");
  for (let i = 0; i < MAX_ROWS_PER_COLLECTION; i++) insert.run("a" + i, BLOB);
  db.exec("COMMIT");
  const capped = await upsertRecord(d1, "ana", "avatars", "overflow", input, 50);
  assert.deepEqual(capped, { ok: false, status: 409, error: RECORD_LIMIT_ERROR });
  const updated = await upsertRecord(d1, "ana", "avatars", "a0", { expectedVersion: 1, blob: BLOB, hasDoc: false, doc: null }, 51);
  assert.equal(updated.ok, true);
  if (updated.ok) assert.equal(updated.version, 2);
});
