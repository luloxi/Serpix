// Server side of encrypted accounts. Shape checks only: the worker never decrypts.
import { isAllowedArgon2Params } from "./crypto/argon2-params.ts";
import type { D1Like, D1RunResult } from "./finance.ts";
import { isDateKey } from "./recurring.ts";

export const E2E_NOT_ENABLED = "Modo cifrado no activado";
export const BLOB_TOO_BIG_ERROR = "El registro cifrado es demasiado grande (máximo 1,9 millones de caracteres).";
export const RECORD_LIMIT_ERROR = "Límite de registros";
export const ENVELOPE_ERROR = "Sobre inválido";
export const WRAP_ERROR = "Envoltura inválida";
export const ADMIN_E2E_ERROR = "El administrador no puede usar el modo cifrado";
export const FIRST_WRAP_ERROR = "La primera envoltura tiene que ser la contraseña";
export const PASSWORD_EXISTS_ERROR = "Ya existe una envoltura de contraseña";
export const WRAP_LIMIT_ERROR = "Límite de envolturas";
export const WRAP_NOT_FOUND = "No encontrada";
export const CANNOT_DELETE_PASSWORD = "No se puede borrar la envoltura de contraseña";
export const CANNOT_DELETE_LAST = "No se puede borrar la última envoltura";
export const ID_IN_USE = "Identificador en uso";
export const BAD_JSON = "JSON inválido";
export const BAD_ID = "Identificador inválido";
export const BAD_COLLECTION = "Colección inválida";
export const DOC_ONLY_ERROR = "doc solo se acepta en documents";
export const BAD_DOC = "Datos de comprobante inválidos";
export const NOT_FOUND = "No encontrado";
export const BAD_QUERY = "Consulta inválida";
export const REPLACE_PASSWORD_ONLY = "Solo se reemplaza la envoltura de contraseña";
export const SCAN_AI_WARNING = "El ticket viaja sin cifrar a Workers AI para leerlo.";
/** First wrap only. Rows stay where they are: there is no migration yet. */
export const LEGACY_DATA_ERROR = "Tu cuenta ya tiene datos sin cifrar. La migración al modo cifrado todavía no está disponible.";

/**
 * Plaintext tables that block the first wrap. Names are fixed identifiers, never request input.
 * `financial_transactions` and `financial_accounts` are the real table names.
 * `timer_state` is the open timer (one row per user, keyed by user_id).
 */
export const LEGACY_TABLES = [
  "contacts",
  "financial_transactions",
  "documents",
  "time_entries",
  "receipts",
  "recurring_rules",
  "activities",
  "projects",
  "tasks",
  "financial_accounts",
  "timer_state",
] as const;

/**
 * Plaintext tables with the same abort trigger, including children (migration 0017).
 * Activation still scans only LEGACY_TABLES: a child row implies its parent.
 */
export const PLAINTEXT_GUARD_EXTRA = [
  "document_items",
  "document_time_entries",
  "activity_contacts",
  "contact_relationships",
  "inquiries",
] as const;

export const PLAINTEXT_GUARD_TABLES = [...LEGACY_TABLES, ...PLAINTEXT_GUARD_EXTRA] as const;

export const MAX_BLOB_CHARS = 1_900_000;
export const MAX_ROWS_PER_COLLECTION = 50_000;
export const MAX_WRAPS = 5;
export const MAX_LIST_LIMIT = 500;

/** 12 zero bytes. AES-GCM nonce length, not a live nonce. */
const TOMBSTONE_NONCE = "AAAAAAAAAAAAAAAA";
/** 16 zero bytes. Empty plaintext plus the GCM tag, not user data. */
const TOMBSTONE_CIPHER = "AAAAAAAAAAAAAAAAAAAAAA";
/** Fixed blob written on delete. The client trusts `deleted`, not this ciphertext. */
export const TOMBSTONE_BLOB = `{"v":1,"n":"${TOMBSTONE_NONCE}","c":"${TOMBSTONE_CIPHER}"}`;

export const COLLECTIONS = [
  "contacts",
  "projects",
  "tasks",
  "accounts",
  "transactions",
  "activities",
  "activity_contacts",
  "time_entries",
  "timer_state",
  "documents",
  "document_items",
  "document_time_entries",
  "receipts",
  "receipt_files",
  "recurring_rules",
  "avatars",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

const DOC_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export type DocMeta = { type: "quote" | "invoice"; number: number; status: DocStatus; dueDate: string | null };

/** HKDF salt, 32 bytes. */
export const HKDF_SALT_CHARS = 43;
/** AES-GCM nonce, 12 bytes. */
export const NONCE_CHARS = 16;
/** Wrapped DEK (32) || tag (16) = 48 bytes. */
export const WRAP_CIPHER_CHARS = 64;
/** Argon2id salt, 16 bytes. */
export const ARGON_SALT_CHARS = 22;
/** WebAuthn PRF salt, 32 bytes. */
export const PRF_SALT_CHARS = 43;

const B64URL = /^[A-Za-z0-9_-]+$/;
const CLIENT_ID = /^[A-Za-z0-9_:.-]{1,120}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,512}$/;

export type PasswordWrap = {
  v: 1;
  type: "password";
  salt: string;
  n: string;
  c: string;
  m: number;
  t: number;
  p: number;
  argonSalt: string;
};
export type PasskeyWrap = {
  v: 1;
  type: "passkey";
  salt: string;
  n: string;
  c: string;
  prfSalt: string;
};
export type KeyWrap = PasswordWrap | PasskeyWrap;

export type Fail = { ok: false; status: number; error?: string; currentVersion?: number };
export type RecordView = {
  collection: string;
  id: string;
  seq: number;
  version: number;
  blob: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  docType: string | null;
  docNumber: number | null;
  docStatus: string | null;
  docDueDate: string | null;
};
export type WrapView = {
  id: string;
  type: string;
  wrap: unknown;
  credentialId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

const fail = (status: number, error?: string, currentVersion?: number): Fail => (
  currentVersion === undefined ? { ok: false, status, error } : { ok: false, status, error, currentVersion }
);

function exactKeys(value: object, keys: readonly string[]): boolean {
  const got = Object.keys(value);
  if (got.length !== keys.length) return false;
  const allowed = new Set(keys);
  return got.every((key) => allowed.has(key));
}

function b64url(value: unknown, chars: number): value is string {
  return typeof value === "string" && value.length === chars && B64URL.test(value);
}

function cipherOk(value: unknown): value is string {
  return typeof value === "string" && value.length >= 22 && value.length % 4 !== 1 && B64URL.test(value);
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function validRecordId(id: string): boolean {
  return CLIENT_ID.test(id);
}

export function validCollection(value: string): value is Collection {
  return (COLLECTIONS as readonly string[]).includes(value);
}

/** Record blob: a JSON string with exactly v=1, n (12 bytes) and c (at least the tag). */
export function validateEnvelope(blob: unknown): { ok: true } | { ok: false; status: 400 | 413; error: string } {
  if (typeof blob !== "string") return { ok: false, status: 400, error: ENVELOPE_ERROR };
  if (blob.length > MAX_BLOB_CHARS) return { ok: false, status: 413, error: BLOB_TOO_BIG_ERROR };
  let parsed: unknown;
  try { parsed = JSON.parse(blob); } catch { return { ok: false, status: 400, error: ENVELOPE_ERROR }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400, error: ENVELOPE_ERROR };
  if (!exactKeys(parsed, ["v", "n", "c"])) return { ok: false, status: 400, error: ENVELOPE_ERROR };
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || !b64url(row.n, NONCE_CHARS) || !cipherOk(row.c)) return { ok: false, status: 400, error: ENVELOPE_ERROR };
  return { ok: true };
}

/**
 * Key wrap. `salt` is the 32-byte HKDF salt. Password wraps also carry Argon2id
 * m/t/p and `argonSalt` (16 bytes). m/t/p must be one of the two client presets.
 * Passkey wraps carry `prfSalt` (32 bytes). Exact keys only, so a wrap cannot smuggle plaintext.
 */
export function validateWrap(value: unknown, type: "password" | "passkey"): { ok: true; wrap: KeyWrap } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: WRAP_ERROR };
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || row.type !== type) return { ok: false, error: WRAP_ERROR };
  if (!b64url(row.salt, HKDF_SALT_CHARS) || !b64url(row.n, NONCE_CHARS) || !b64url(row.c, WRAP_CIPHER_CHARS)) return { ok: false, error: WRAP_ERROR };
  if (type === "password") {
    if (!exactKeys(row, ["v", "type", "salt", "n", "c", "m", "t", "p", "argonSalt"])) return { ok: false, error: WRAP_ERROR };
    const cost = { m: row.m, t: row.t, p: row.p };
    if (!isAllowedArgon2Params(cost)) return { ok: false, error: WRAP_ERROR };
    if (!b64url(row.argonSalt, ARGON_SALT_CHARS)) return { ok: false, error: WRAP_ERROR };
    return { ok: true, wrap: { v: 1, type: "password", salt: row.salt, n: row.n, c: row.c, m: cost.m, t: cost.t, p: cost.p, argonSalt: row.argonSalt } };
  }
  if (!exactKeys(row, ["v", "type", "salt", "n", "c", "prfSalt"])) return { ok: false, error: WRAP_ERROR };
  if (!b64url(row.prfSalt, PRF_SALT_CHARS)) return { ok: false, error: WRAP_ERROR };
  return { ok: true, wrap: { v: 1, type: "passkey", salt: row.salt, n: row.n, c: row.c, prfSalt: row.prfSalt } };
}

export function storedWrap(wrap: KeyWrap): string {
  return JSON.stringify(wrap);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDoc(value: unknown): { ok: true; doc: DocMeta } | { ok: false; error: string } {
  if (!isObject(value) || !exactKeys(value, ["type", "number", "status", "dueDate"])) return { ok: false, error: BAD_DOC };
  if (value.type !== "quote" && value.type !== "invoice") return { ok: false, error: BAD_DOC };
  if (!intIn(value.number, 1, 1_000_000_000)) return { ok: false, error: BAD_DOC };
  if (typeof value.status !== "string" || !(DOC_STATUSES as readonly string[]).includes(value.status)) return { ok: false, error: BAD_DOC };
  if (value.dueDate !== null && !isDateKey(value.dueDate)) return { ok: false, error: BAD_DOC };
  return { ok: true, doc: { type: value.type, number: value.number, status: value.status as DocStatus, dueDate: value.dueDate } };
}

export function parseRecordWrite(collection: string, id: string, body: unknown): { ok: true; expectedVersion: number; blob: string; hasDoc: boolean; doc: DocMeta | null } | Fail {
  if (!validCollection(collection)) return fail(400, BAD_COLLECTION);
  if (!validRecordId(id)) return fail(400, BAD_ID);
  if (!isObject(body)) return fail(400, BAD_JSON);
  if ("doc" in body && collection !== "documents") return fail(400, DOC_ONLY_ERROR);
  const allowed = collection === "documents" ? ["expectedVersion", "blob", "doc"] : ["expectedVersion", "blob"];
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key)) || !keys.includes("expectedVersion") || !keys.includes("blob")) return fail(400, BAD_JSON);
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) return fail(400, BAD_JSON);
  if (typeof body.blob !== "string") return fail(400, ENVELOPE_ERROR);
  const envelope = validateEnvelope(body.blob);
  if (!envelope.ok) return fail(envelope.status, envelope.error);
  if (!("doc" in body)) return { ok: true, expectedVersion: body.expectedVersion, blob: body.blob, hasDoc: false, doc: null };
  const doc = parseDoc(body.doc);
  if (!doc.ok) return fail(400, doc.error);
  return { ok: true, expectedVersion: body.expectedVersion, blob: body.blob, hasDoc: true, doc: doc.doc };
}

export function parseRecordDelete(body: unknown): { ok: true; expectedVersion: number } | Fail {
  if (!isObject(body) || !exactKeys(body, ["expectedVersion"])) return fail(400, BAD_JSON);
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) return fail(400, BAD_JSON);
  return { ok: true, expectedVersion: body.expectedVersion };
}

export function parseListQuery(collection: string | null, sinceRaw: string | null, limitRaw: string | null): { ok: true; collection: string | null; since: number; limit: number } | Fail {
  let parsedCollection: string | null = null;
  if (collection != null && collection !== "") {
    if (!validCollection(collection)) return fail(400, BAD_COLLECTION);
    parsedCollection = collection;
  }
  const since = sinceRaw == null || sinceRaw === "" ? 0 : Number(sinceRaw);
  if (!Number.isSafeInteger(since) || since < 0 || (sinceRaw != null && sinceRaw !== "" && !/^(0|[1-9]\d*)$/.test(sinceRaw))) return fail(400, BAD_QUERY);
  const limit = limitRaw == null || limitRaw === "" ? MAX_LIST_LIMIT : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT || (limitRaw != null && limitRaw !== "" && !/^[1-9]\d*$/.test(limitRaw))) return fail(400, BAD_QUERY);
  return { ok: true, collection: parsedCollection, since, limit };
}

export function parseCounterBody(body: unknown): { ok: true; kind: "quote" | "invoice" } | Fail {
  if (!isObject(body) || !exactKeys(body, ["kind"])) return fail(400, BAD_JSON);
  if (body.kind !== "quote" && body.kind !== "invoice") return fail(400, BAD_JSON);
  return { ok: true, kind: body.kind };
}

export function parseWrapCreate(body: unknown): { ok: true; type: "password" | "passkey"; wrap: unknown; credentialId: string | null; id: string | null } | Fail {
  if (!isObject(body)) return fail(400, BAD_JSON);
  const keys = Object.keys(body);
  if (keys.some((key) => !["type", "wrap", "credentialId", "id"].includes(key)) || !keys.includes("type") || !keys.includes("wrap")) return fail(400, BAD_JSON);
  if (body.type !== "password" && body.type !== "passkey") return fail(400, BAD_JSON);
  if (!isObject(body.wrap)) return fail(400, WRAP_ERROR);
  let credentialId: string | null = null;
  if ("credentialId" in body && body.credentialId != null) {
    if (typeof body.credentialId !== "string" || !CREDENTIAL_ID.test(body.credentialId)) return fail(400, BAD_JSON);
    credentialId = body.credentialId;
  }
  let id: string | null = null;
  if ("id" in body && body.id != null) {
    if (typeof body.id !== "string" || !validRecordId(body.id)) return fail(400, BAD_ID);
    id = body.id;
  }
  if (body.type === "password" && credentialId) return fail(400, "La contraseña no lleva credencial");
  return { ok: true, type: body.type, wrap: body.wrap, credentialId, id };
}

export function parseWrapReplace(body: unknown): { ok: true; wrap: unknown } | Fail {
  if (!isObject(body) || !exactKeys(body, ["wrap"]) || !isObject(body.wrap)) return fail(400, BAD_JSON);
  return { ok: true, wrap: body.wrap };
}

export function parseTouch(body: unknown): { ok: true } | Fail {
  if (!isObject(body) || !exactKeys(body, ["touch"]) || body.touch !== true) return fail(400, BAD_JSON);
  return { ok: true };
}

export function httpError(result: Fail): { status: number; body: Record<string, unknown> } {
  if (result.currentVersion !== undefined && result.error === undefined) return { status: result.status, body: { currentVersion: result.currentVersion } };
  const body: Record<string, unknown> = { error: result.error ?? "No se pudo guardar" };
  if (result.currentVersion !== undefined) body.currentVersion = result.currentVersion;
  return { status: result.status, body };
}

type BatchDb = D1Like & { batch: NonNullable<D1Like["batch"]> };

function withBatch(db: D1Like): BatchDb {
  if (typeof db.batch !== "function") throw new Error("batch required");
  return db as BatchDb;
}

function isConstraint(error: unknown): boolean {
  const err = error as { errcode?: number };
  if (err?.errcode === 19) return true;
  const message = String(error);
  return message.includes("UNIQUE") || message.includes("CONSTRAINT") || message.includes("constraint");
}

export async function encryptionMode(db: D1Like, userId: string): Promise<"server" | "e2e"> {
  const row = await db.prepare("SELECT encryption_mode AS mode FROM user WHERE id = ?").bind(userId).first<{ mode: string }>();
  return row?.mode === "e2e" ? "e2e" : "server";
}

function legacyTable(name: string): string {
  if (!(LEGACY_TABLES as readonly string[]).includes(name)) throw new Error("unknown legacy table");
  return name;
}

/** True when this user still has any plaintext row. Read-only: nothing is deleted. */
export async function hasLegacyData(db: D1Like, userId: string): Promise<boolean> {
  const checks = LEGACY_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${legacyTable(table)} WHERE user_id = ?)`).join(" OR ");
  const row = await db.prepare(`SELECT 1 AS n WHERE ${checks}`).bind(...LEGACY_TABLES.map(() => userId)).first<{ n: number }>();
  return row != null;
}

const BUMP_SQL = `INSERT INTO e2e_counters (user_id, kind, value)
SELECT ?1, 'seq', 1
WHERE (
  (?2 = 0 AND NOT EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?3 AND id=?4)
    AND (SELECT COUNT(*) FROM records WHERE user_id=?1 AND collection=?3) < ?5)
  OR EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?3 AND id=?4 AND version=?2)
)
ON CONFLICT(user_id, kind) DO UPDATE SET value = value + 1
WHERE (
  (?2 = 0 AND NOT EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?3 AND id=?4)
    AND (SELECT COUNT(*) FROM records WHERE user_id=?1 AND collection=?3) < ?5)
  OR EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?3 AND id=?4 AND version=?2)
)`;

const WRITE_SQL = `INSERT INTO records (user_id, collection, id, seq, version, blob, created_at, updated_at, deleted, doc_type, doc_number, doc_status, doc_due_date)
SELECT ?1, ?2, ?3, (SELECT value FROM e2e_counters WHERE user_id=?1 AND kind='seq'), 1, ?4, ?5, ?5, 0, ?6, ?7, ?8, ?9
WHERE changes() = 1
ON CONFLICT(user_id, collection, id) DO UPDATE SET
  seq = (SELECT value FROM e2e_counters WHERE user_id=?1 AND kind='seq'),
  version = records.version + 1,
  blob = excluded.blob,
  updated_at = excluded.updated_at,
  deleted = 0,
  doc_type = CASE WHEN ?10 = 1 THEN excluded.doc_type ELSE records.doc_type END,
  doc_number = CASE WHEN ?10 = 1 THEN excluded.doc_number ELSE records.doc_number END,
  doc_status = CASE WHEN ?10 = 1 THEN excluded.doc_status ELSE records.doc_status END,
  doc_due_date = CASE WHEN ?10 = 1 THEN excluded.doc_due_date ELSE records.doc_due_date END
WHERE records.version = ?11 AND changes() = 1
RETURNING seq, version`;

const TOMB_BUMP_SQL = `INSERT INTO e2e_counters (user_id, kind, value)
SELECT ?1, 'seq', 1
WHERE EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?2 AND id=?3 AND version=?4)
ON CONFLICT(user_id, kind) DO UPDATE SET value = value + 1
WHERE EXISTS (SELECT 1 FROM records WHERE user_id=?1 AND collection=?2 AND id=?3 AND version=?4)`;

const TOMB_SQL = `UPDATE records SET deleted=1, blob=?5, version=version+1,
  seq=(SELECT value FROM e2e_counters WHERE user_id=?1 AND kind='seq'), updated_at=?6
WHERE user_id=?1 AND collection=?2 AND id=?3 AND version=?4 AND changes()=1
RETURNING seq, version`;

type SeqVersion = { seq: number; version: number };

function returnedRow(result: D1RunResult | undefined): SeqVersion | null {
  const row = result?.results?.[0] as { seq?: unknown; version?: unknown } | undefined;
  if (!row || result!.meta.changes < 1) return null;
  const seq = Number(row.seq);
  const version = Number(row.version);
  if (!Number.isInteger(seq) || !Number.isInteger(version)) return null;
  return { seq, version };
}

export async function upsertRecord(
  db: D1Like,
  userId: string,
  collection: string,
  id: string,
  input: { expectedVersion: number; blob: string; hasDoc: boolean; doc: DocMeta | null },
  now: number,
): Promise<{ ok: true; seq: number; version: number; created: boolean } | Fail> {
  const batch = withBatch(db);
  const doc = input.doc;
  const bump = batch.prepare(BUMP_SQL).bind(userId, input.expectedVersion, collection, id, MAX_ROWS_PER_COLLECTION);
  const write = batch.prepare(WRITE_SQL).bind(
    userId, collection, id, input.blob, now,
    doc?.type ?? null, doc?.number ?? null, doc?.status ?? null, doc?.dueDate ?? null,
    input.hasDoc ? 1 : 0, input.expectedVersion,
  );
  const [, written] = await batch.batch([bump, write]);
  const row = returnedRow(written);
  if (row) return { ok: true, seq: row.seq, version: row.version, created: input.expectedVersion === 0 };
  const current = await db.prepare("SELECT version FROM records WHERE user_id=? AND collection=? AND id=?").bind(userId, collection, id).first<{ version: number }>();
  if (current) return { ok: false, status: 409, currentVersion: Number(current.version) };
  if (input.expectedVersion === 0) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id=? AND collection=?").bind(userId, collection).first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_ROWS_PER_COLLECTION) return fail(409, RECORD_LIMIT_ERROR);
  }
  return { ok: false, status: 409, currentVersion: 0 };
}

export async function tombstoneRecord(
  db: D1Like,
  userId: string,
  collection: string,
  id: string,
  expectedVersion: number,
  now: number,
): Promise<{ ok: true; seq: number; version: number } | Fail> {
  const batch = withBatch(db);
  const bump = batch.prepare(TOMB_BUMP_SQL).bind(userId, collection, id, expectedVersion);
  const write = batch.prepare(TOMB_SQL).bind(userId, collection, id, expectedVersion, TOMBSTONE_BLOB, now);
  const [, written] = await batch.batch([bump, write]);
  const row = returnedRow(written);
  if (row) return { ok: true, seq: row.seq, version: row.version };
  const current = await db.prepare("SELECT version FROM records WHERE user_id=? AND collection=? AND id=?").bind(userId, collection, id).first<{ version: number }>();
  if (!current) return fail(404, NOT_FOUND);
  return { ok: false, status: 409, currentVersion: Number(current.version) };
}

type RawRecord = {
  collection: string;
  id: string;
  seq: number;
  version: number;
  blob: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  doc_type: string | null;
  doc_number: number | null;
  doc_status: string | null;
  doc_due_date: string | null;
};

function viewRecord(row: RawRecord): RecordView {
  return {
    collection: row.collection,
    id: row.id,
    seq: Number(row.seq),
    version: Number(row.version),
    blob: row.blob,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deleted: Number(row.deleted) === 1,
    docType: row.doc_type,
    docNumber: row.doc_number == null ? null : Number(row.doc_number),
    docStatus: row.doc_status,
    docDueDate: row.doc_due_date,
  };
}

const LIST_COLUMNS = "collection, id, seq, version, blob, created_at, updated_at, deleted, doc_type, doc_number, doc_status, doc_due_date";

export async function listRecords(
  db: D1Like,
  userId: string,
  query: { collection: string | null; since: number; limit: number },
): Promise<{ records: RecordView[]; cursor: number; more: boolean }> {
  const sql = query.collection
    ? `SELECT ${LIST_COLUMNS} FROM records WHERE user_id=? AND seq>? AND collection=? ORDER BY seq ASC LIMIT ?`
    : `SELECT ${LIST_COLUMNS} FROM records WHERE user_id=? AND seq>? ORDER BY seq ASC LIMIT ?`;
  const bound = query.collection
    ? db.prepare(sql).bind(userId, query.since, query.collection, query.limit + 1)
    : db.prepare(sql).bind(userId, query.since, query.limit + 1);
  const rows = (await bound.all<RawRecord>()).results ?? [];
  const more = rows.length > query.limit;
  const page = more ? rows.slice(0, query.limit) : rows;
  const cursor = page.length ? Number(page[page.length - 1].seq) : query.since;
  return { records: page.map(viewRecord), cursor, more };
}

export async function nextCounter(db: D1Like, userId: string, kind: "quote" | "invoice"): Promise<number> {
  const result = await db.prepare(
    "INSERT INTO e2e_counters (user_id, kind, value) VALUES (?, ?, 1) ON CONFLICT(user_id, kind) DO UPDATE SET value = value + 1 RETURNING value",
  ).bind(userId, kind).run();
  const value = Number((result.results?.[0] as { value?: unknown } | undefined)?.value);
  if (!Number.isInteger(value) || value < 1) throw new Error("counter");
  return value;
}

export async function listKeys(db: D1Like, userId: string): Promise<{ mode: "server" | "e2e"; legacyData: boolean; wraps: WrapView[] }> {
  const mode = await encryptionMode(db, userId);
  const legacyData = await hasLegacyData(db, userId);
  const rows = (await db.prepare(
    "SELECT id, type, wrap, credential_id AS credentialId, created_at AS createdAt, last_used_at AS lastUsedAt FROM user_keys WHERE user_id=? ORDER BY created_at ASC, id ASC",
  ).bind(userId).all<{ id: string; type: string; wrap: string; credentialId: string | null; createdAt: number; lastUsedAt: number | null }>()).results ?? [];
  const wraps: WrapView[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    wrap: JSON.parse(row.wrap) as unknown,
    credentialId: row.credentialId ?? null,
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt == null ? null : Number(row.lastUsedAt),
  }));
  return { mode, legacyData, wraps };
}

async function userMode(db: D1Like, userId: string): Promise<{ role: string; mode: string } | null> {
  return db.prepare("SELECT role, encryption_mode AS mode FROM user WHERE id=?").bind(userId).first<{ role: string; mode: string }>();
}

export async function addWrap(
  db: D1Like,
  userId: string,
  input: { id: string | null; type: "password" | "passkey"; wrap: unknown; credentialId: string | null },
  now: number,
): Promise<{ ok: true; id: string } | Fail> {
  const validated = validateWrap(input.wrap, input.type);
  if (!validated.ok) return fail(400, validated.error);
  if (input.type === "password" && input.credentialId) return fail(400, "La contraseña no lleva credencial");
  const id = input.id ?? crypto.randomUUID();
  if (!validRecordId(id)) return fail(400, BAD_ID);
  const account = await userMode(db, userId);
  if (!account) return fail(404, NOT_FOUND);
  if (account.role === "admin") return fail(403, ADMIN_E2E_ERROR);
  const wrapJson = storedWrap(validated.wrap);
  if (account.mode !== "e2e") {
    if (input.type !== "password") return fail(400, FIRST_WRAP_ERROR);
    // Refuse before the mode flip. The WHERE clause is the same check, so a row inserted
    // between the read and the batch cannot sneak the account into e2e. Nothing is deleted.
    if (await hasLegacyData(db, userId)) return fail(409, LEGACY_DATA_ERROR);
    const guard = LEGACY_TABLES.map((table) => `NOT EXISTS (SELECT 1 FROM ${legacyTable(table)} WHERE user_id=?)`).join(" AND ");
    const batch = withBatch(db);
    const update = batch.prepare(
      `UPDATE user SET encryption_mode='e2e' WHERE id=? AND role!='admin' AND encryption_mode='server' AND ${guard}`,
    ).bind(userId, ...LEGACY_TABLES.map(() => userId));
    const insert = batch.prepare(
      "INSERT INTO user_keys (id, user_id, type, wrap, credential_id, created_at, last_used_at) SELECT ?, ?, 'password', ?, ?, ?, NULL WHERE changes()=1",
    ).bind(id, userId, wrapJson, null, now);
    try {
      const [, inserted] = await batch.batch([update, insert]);
      if (inserted.meta.changes === 1) return { ok: true, id };
    } catch (error) {
      if (isConstraint(error)) return fail(409, String(error).includes("user_keys_one_password") ? PASSWORD_EXISTS_ERROR : ID_IN_USE);
      throw error;
    }
    if (await hasLegacyData(db, userId)) return fail(409, LEGACY_DATA_ERROR);
    return fail(409, "No se pudo activar el cifrado");
  }
  const inserted = db.prepare(
    `INSERT INTO user_keys (id, user_id, type, wrap, credential_id, created_at, last_used_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL
     WHERE (SELECT COUNT(*) FROM user_keys WHERE user_id=?2) < ?7
       AND (?3 != 'password' OR NOT EXISTS (SELECT 1 FROM user_keys WHERE user_id=?2 AND type='password'))
       AND (SELECT encryption_mode FROM user WHERE id=?2 AND role!='admin') = 'e2e'`,
  ).bind(id, userId, input.type, wrapJson, input.credentialId, now, MAX_WRAPS);
  try {
    const result = await inserted.run();
    if (result.meta.changes === 1) return { ok: true, id };
  } catch (error) {
    if (isConstraint(error)) return fail(409, String(error).includes("user_keys_one_password") ? PASSWORD_EXISTS_ERROR : ID_IN_USE);
    throw error;
  }
  const counts = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN type='password' THEN 1 ELSE 0 END) AS passwords FROM user_keys WHERE user_id=?").bind(userId).first<{ n: number; passwords: number }>();
  if (Number(counts?.n ?? 0) >= MAX_WRAPS) return fail(409, WRAP_LIMIT_ERROR);
  if (input.type === "password" && Number(counts?.passwords ?? 0) >= 1) return fail(409, PASSWORD_EXISTS_ERROR);
  return fail(409, "No se pudo guardar la envoltura");
}

export async function replacePasswordWrap(db: D1Like, userId: string, id: string, wrap: unknown): Promise<{ ok: true } | Fail> {
  const validated = validateWrap(wrap, "password");
  if (!validated.ok) return fail(400, validated.error);
  const result = await db.prepare("UPDATE user_keys SET wrap=? WHERE id=? AND user_id=? AND type='password'").bind(storedWrap(validated.wrap), id, userId).run();
  if (result.meta.changes > 0) return { ok: true };
  const row = await db.prepare("SELECT type FROM user_keys WHERE id=? AND user_id=?").bind(id, userId).first<{ type: string }>();
  if (!row) return fail(404, WRAP_NOT_FOUND);
  return fail(409, REPLACE_PASSWORD_ONLY);
}

export async function touchWrap(db: D1Like, userId: string, id: string, now: number): Promise<{ ok: true } | Fail> {
  const result = await db.prepare("UPDATE user_keys SET last_used_at=? WHERE id=? AND user_id=?").bind(now, id, userId).run();
  if (result.meta.changes > 0) return { ok: true };
  return fail(404, WRAP_NOT_FOUND);
}

export async function deleteWrap(db: D1Like, userId: string, id: string): Promise<{ ok: true } | Fail> {
  const result = await db.prepare(
    "DELETE FROM user_keys WHERE id=? AND user_id=? AND type!='password' AND (SELECT COUNT(*) FROM user_keys WHERE user_id=?) > 1",
  ).bind(id, userId, userId).run();
  if (result.meta.changes > 0) return { ok: true };
  const row = await db.prepare("SELECT type FROM user_keys WHERE id=? AND user_id=?").bind(id, userId).first<{ type: string }>();
  if (!row) return fail(404, WRAP_NOT_FOUND);
  if (row.type === "password") return fail(409, CANNOT_DELETE_PASSWORD);
  return fail(409, CANNOT_DELETE_LAST);
}
