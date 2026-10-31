// Cuentix -> Serpix movement sync. Pure logic (no Next.js or Cloudflare imports) so node:test can load it.
import type { D1Bound, D1Like } from "./finance.ts";

export const MAX_SYNC_BODY_BYTES = 16 * 1024;
export const SYNC_MAX_SKEW_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 15 * 60 * 1000;

const NONCE_SOURCE = "cuentix";
const enc = new TextEncoder();
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{1,16}$/;
const NONCE_RE = /^[0-9a-f]{32,256}$/;
const SIG_RE = /^v1=[0-9a-f]{64}$/;

const unauthorized = { status: 401, body: { error: "unauthorized" } };
const forbidden = { status: 403, body: { error: "forbidden" } };
const invalid = { status: 400, body: { error: "invalid_payload" } };
const unavailable = { status: 500, body: { error: "unavailable" } };

export type SyncResult = { status: number; body: Record<string, unknown> };

export type CuentixSyncInput = {
  secret: string | undefined;
  ownerEmail: string | undefined;
  rawBody: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  now: number;
};

type Kind = "income" | "expense";
type Currency = "ARS" | "USD";

type UpsertEvent = {
  type: "upsert";
  eventId: string;
  sourceId: string;
  version: number;
  occurredAt: string;
  kind: Kind;
  amountMinor: number;
  currency: Currency;
  description: string | null;
  category: string;
};

type DeleteEvent = {
  type: "delete";
  eventId: string;
  sourceId: string;
  version: number;
};

type SyncEvent = UpsertEvent | DeleteEvent;

type OwnerRow = { id: string; role: string; approvalStatus: string; encryption_mode?: string | null };

type LinkRow = {
  id: string;
  kind: string;
  amount_minor: number;
  occurred_at: string;
  source: string | null;
  deleted_at: number | null;
  linked_to: string | null;
  link_suppressed: string | null;
  currency: string;
  source_version: number | null;
};

const LINK_SQL = "SELECT t.id, t.kind, t.amount_minor, t.occurred_at, t.source, t.deleted_at, t.linked_to, t.link_suppressed, t.source_version, a.currency FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id AND a.user_id = t.user_id WHERE t.id=? AND t.user_id=?";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(value.length / 2);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function isDateKey(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

async function hmacKey(secret: string, use: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);
}

/** `v1=` + lowercase hex HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBody}`). */
export async function signSyncRequest(secret: string, timestamp: string, nonce: string, rawBody: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${nonce}.${rawBody}`));
  return "v1=" + hex(new Uint8Array(mac));
}

/** Timing-safe check via crypto.subtle.verify. Malformed signatures are false, not thrown. */
export async function verifySyncSignature(secret: string, timestamp: string, nonce: string, rawBody: string, signature: string): Promise<boolean> {
  if (!SIG_RE.test(signature)) return false;
  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, hexToBytes(signature.slice(3)), enc.encode(`${timestamp}.${nonce}.${rawBody}`));
}

export function syncHeadersWellFormed(timestamp: string | null, nonce: string | null, signature: string | null): boolean {
  if (!timestamp || !nonce || !signature) return false;
  if (!TS_RE.test(timestamp) || !NONCE_RE.test(nonce) || !SIG_RE.test(signature)) return false;
  if (nonce.length % 2 !== 0) return false;
  return Number.isSafeInteger(Number(timestamp));
}

export function syncTimestampFresh(timestamp: string, now: number, skew = SYNC_MAX_SKEW_MS): boolean {
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  return Math.abs(now - ts) <= skew;
}

/**
 * Admin and approved only. Guests and other users are never the sync target.
 * `encryptionEnabled` is `user.encryption_mode`. Only the explicit value "server" syncs.
 * A missing flag, null, "e2e", or any other value is refused.
 */
export function ownerIsSyncable(user: { role: string; approvalStatus: string; encryptionEnabled?: unknown }): boolean {
  if (user.role !== "admin" || user.approvalStatus !== "approved") return false;
  return user.encryptionEnabled === "server";
}

export function cuentixAccountId(userId: string, currency: Currency): string {
  return "cuentix-" + currency.toLowerCase() + "-" + userId;
}

export function cuentixTxId(sourceId: string): string {
  return "cuentix-" + sourceId;
}

function strField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

function versionOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function sourceIdOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 120) return null;
  if (value.trim() !== value || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

/** Validates the raw JSON body. `delete` ignores the upsert-only fields. */
export function parseSyncEvent(rawBody: string): { ok: true; event: SyncEvent } | { ok: false } {
  let raw: unknown;
  try { raw = JSON.parse(rawBody); } catch { return { ok: false }; }
  if (!raw || typeof raw !== "object") return { ok: false };
  const b = raw as Record<string, unknown>;
  if (b.v !== 1 || b.source !== "cuentix") return { ok: false };
  if (typeof b.event_id !== "string" || !UUID_RE.test(b.event_id)) return { ok: false };
  const sourceId = sourceIdOf(b.source_id);
  const version = versionOf(b.version);
  if (!sourceId || version === null) return { ok: false };
  if (b.type === "delete") return { ok: true, event: { type: "delete", eventId: b.event_id.toLowerCase(), sourceId, version } };
  if (b.type !== "upsert") return { ok: false };
  if (b.kind !== "income" && b.kind !== "expense") return { ok: false };
  if (b.currency !== "ARS" && b.currency !== "USD") return { ok: false };
  if (typeof b.amount_minor !== "number" || !Number.isSafeInteger(b.amount_minor) || b.amount_minor <= 0) return { ok: false };
  if (typeof b.occurred_at !== "string" || !isDateKey(b.occurred_at)) return { ok: false };
  if (b.description !== undefined && typeof b.description !== "string") return { ok: false };
  const description = strField(b.description ?? "", 500);
  if (description === null) return { ok: false };
  if (b.category !== undefined && typeof b.category !== "string") return { ok: false };
  const categoryRaw = strField(b.category ?? "", 100);
  if (categoryRaw === null) return { ok: false };
  return {
    ok: true,
    event: {
      type: "upsert",
      eventId: b.event_id.toLowerCase(),
      sourceId,
      version,
      occurredAt: b.occurred_at,
      kind: b.kind,
      amountMinor: b.amount_minor,
      currency: b.currency,
      description: description || null,
      category: categoryRaw || "Cuentix",
    },
  };
}

function isNonceReplay(error: unknown): boolean {
  return String(error).includes("integration_nonces");
}

async function runBatch(db: D1Like, statements: D1Bound[]): Promise<Array<{ meta: { changes: number } }>> {
  if (db.batch) return db.batch(statements);
  const out = [];
  for (const statement of statements) out.push(await statement.run());
  return out;
}

async function ensureAccount(db: D1Like, userId: string, currency: Currency, now: number): Promise<string> {
  const id = cuentixAccountId(userId, currency);
  await db.prepare("INSERT OR IGNORE INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,0,?,?)")
    .bind(id, userId, "Cuentix (" + currency + ")", currency, now, now).run();
  return id;
}

async function loadLink(db: D1Like, userId: string, id: string): Promise<LinkRow | null> {
  return db.prepare(LINK_SQL).bind(id, userId).first<LinkRow>();
}

function sameMovement(a: LinkRow, b: LinkRow): boolean {
  return a.currency === b.currency && a.kind === b.kind && Number(a.amount_minor) === Number(b.amount_minor) && a.occurred_at === b.occurred_at;
}

function oppositeSide(a: LinkRow, b: LinkRow): boolean {
  return (a.source == null) !== (b.source == null);
}

async function clearCounterpart(db: D1Like, userId: string, otherId: string, now: number): Promise<void> {
  await db.prepare("UPDATE financial_transactions SET linked_to=NULL, excluded_from_totals=0, link_suppressed=NULL, updated_at=? WHERE id=? AND user_id=?").bind(now, otherId, userId).run();
}

async function applyLink(db: D1Like, userId: string, manualId: string, syncedId: string, now: number): Promise<void> {
  await db.prepare("UPDATE financial_transactions SET linked_to=?, excluded_from_totals=0, link_suppressed=NULL, updated_at=? WHERE id=? AND user_id=?").bind(syncedId, now, manualId, userId).run();
  await db.prepare("UPDATE financial_transactions SET linked_to=?, excluded_from_totals=1, link_suppressed=NULL, updated_at=? WHERE id=? AND user_id=?").bind(manualId, now, syncedId, userId).run();
}

/**
 * Links a manual row and a Cuentix row that are the same movement (user, currency, kind, amount, date).
 * The manual row keeps counting. The synced row is excluded so the total is not doubled.
 * A pair the user unlinked (link_suppressed) is not linked again while it still matches.
 */
export async function reconcileManual(db: D1Like, userId: string, txId: string, now: number): Promise<void> {
  await reconcile(db, userId, txId, now, new Set());
}

async function reconcile(db: D1Like, userId: string, txId: string, now: number, seen: Set<string>): Promise<void> {
  if (seen.has(txId)) return;
  seen.add(txId);
  const row = await loadLink(db, userId, txId);
  if (!row) return;
  if (row.deleted_at != null) {
    if (row.linked_to) {
      const other = row.linked_to;
      await db.prepare("UPDATE financial_transactions SET linked_to=NULL, excluded_from_totals=0, updated_at=? WHERE id=? AND user_id=?").bind(now, row.id, userId).run();
      await clearCounterpart(db, userId, other, now);
    }
    return;
  }
  if (row.linked_to) {
    const other = await loadLink(db, userId, row.linked_to);
    if (other && other.deleted_at == null && oppositeSide(row, other) && sameMovement(row, other)) {
      const manualId = row.source ? other.id : row.id;
      const syncedId = row.source ? row.id : other.id;
      await applyLink(db, userId, manualId, syncedId, now);
      return;
    }
    const previous = row.linked_to;
    await db.prepare("UPDATE financial_transactions SET linked_to=NULL, excluded_from_totals=0, updated_at=? WHERE id=? AND user_id=?").bind(now, row.id, userId).run();
    await clearCounterpart(db, userId, previous, now);
    await reconcile(db, userId, previous, now, seen);
  }
  const fresh = await loadLink(db, userId, txId);
  if (!fresh || fresh.deleted_at != null || fresh.linked_to) return;
  if (fresh.link_suppressed) {
    const suppressed = await loadLink(db, userId, fresh.link_suppressed);
    if (!suppressed || suppressed.deleted_at != null || !oppositeSide(fresh, suppressed) || !sameMovement(fresh, suppressed)) {
      await db.prepare("UPDATE financial_transactions SET link_suppressed=NULL, updated_at=? WHERE id=? AND user_id=?").bind(now, fresh.id, userId).run();
      fresh.link_suppressed = null;
    }
  }
  const wantManual = fresh.source ? 1 : 0;
  const skip = fresh.link_suppressed ?? fresh.id;
  const found = await db.prepare(
    "SELECT t.id FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id AND a.user_id = t.user_id WHERE t.user_id=? AND t.deleted_at IS NULL AND t.linked_to IS NULL AND t.id<>? AND t.kind=? AND t.amount_minor=? AND t.occurred_at=? AND a.currency=? AND ((?=1 AND t.source IS NULL) OR (?=0 AND t.source IS NOT NULL)) AND (t.link_suppressed IS NULL OR t.link_suppressed<>?) AND t.id<>? ORDER BY t.created_at ASC, t.id ASC LIMIT 1",
  ).bind(userId, fresh.id, fresh.kind, Number(fresh.amount_minor), fresh.occurred_at, fresh.currency, wantManual, wantManual, fresh.id, skip).first<{ id: string }>();
  if (!found || seen.has(found.id)) return;
  const other = await loadLink(db, userId, found.id);
  if (!other || other.deleted_at != null || other.linked_to || !oppositeSide(fresh, other) || !sameMovement(fresh, other)) return;
  const manualId = fresh.source ? other.id : fresh.id;
  const syncedId = fresh.source ? fresh.id : other.id;
  await applyLink(db, userId, manualId, syncedId, now);
}

/** User action: both rows count again, and this pair is not auto-linked while it still matches. */
export async function unlinkTransaction(db: D1Like, userId: string, txId: string, now: number): Promise<SyncResult> {
  const row = await db.prepare("SELECT id, linked_to AS linkedTo, deleted_at AS deletedAt FROM financial_transactions WHERE id=? AND user_id=?").bind(txId, userId).first<{ id: string; linkedTo: string | null; deletedAt: number | null }>();
  if (!row || row.deletedAt != null) return { status: 404, body: { error: "Registro no encontrado" } };
  if (!row.linkedTo) return { status: 200, body: { ok: true, linked: false } };
  const other = row.linkedTo;
  await db.prepare("UPDATE financial_transactions SET linked_to=NULL, excluded_from_totals=0, link_suppressed=?, updated_at=? WHERE id=? AND user_id=?").bind(other, now, txId, userId).run();
  await db.prepare("UPDATE financial_transactions SET linked_to=NULL, excluded_from_totals=0, link_suppressed=?, updated_at=? WHERE id=? AND user_id=?").bind(txId, now, other, userId).run();
  return { status: 200, body: { ok: true, linked: false } };
}

/** After a manual row is hard-deleted, the Cuentix side counts again. */
export async function clearCounterpartLink(db: D1Like, userId: string, otherId: string | null, now: number): Promise<void> {
  if (!otherId) return;
  await clearCounterpart(db, userId, otherId, now);
}

type Stored = { id: string; source_version: number | null; linked_to: string | null; deleted_at: number | null };

async function loadStored(db: D1Like, userId: string, sourceId: string): Promise<Stored | null> {
  return db.prepare("SELECT id, source_version, linked_to, deleted_at FROM financial_transactions WHERE user_id=? AND source=? AND source_id=?").bind(userId, NONCE_SOURCE, sourceId).first<Stored>();
}

function versionResult(stored: number | null, version: number): SyncResult {
  if (stored != null && Number(stored) === version) return { status: 200, body: { ok: true, applied: false, reason: "same" } };
  return { status: 200, body: { ok: true, applied: false, reason: "stale" } };
}

async function applyUpsert(db: D1Like, userId: string, event: UpsertEvent, now: number): Promise<SyncResult> {
  const current = await loadStored(db, userId, event.sourceId);
  if (current && current.source_version != null && Number(current.source_version) >= event.version) return versionResult(current.source_version, event.version);
  if (!current) {
    const tomb = await db.prepare("SELECT version FROM integration_tombstones WHERE source=? AND source_id=? AND user_id=?").bind(NONCE_SOURCE, event.sourceId, userId).first<{ version: number }>();
    if (tomb && Number(tomb.version) >= event.version) return { status: 200, body: { ok: true, applied: false, reason: "stale" } };
  }
  const accountId = await ensureAccount(db, userId, event.currency, now);
  const id = current?.id ?? cuentixTxId(event.sourceId);
  const wrote = await db.prepare(
    "INSERT INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at,updated_at,source,source_id,source_version,deleted_at,excluded_from_totals,linked_to,link_suppressed) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,NULL) ON CONFLICT(source, source_id) WHERE source IS NOT NULL DO UPDATE SET account_id=excluded.account_id, kind=excluded.kind, amount_minor=excluded.amount_minor, category=excluded.category, description=excluded.description, occurred_at=excluded.occurred_at, source_version=excluded.source_version, deleted_at=NULL, excluded_from_totals=0, updated_at=excluded.updated_at WHERE financial_transactions.user_id=excluded.user_id AND financial_transactions.source_version < excluded.source_version",
  ).bind(id, userId, accountId, event.kind, event.amountMinor, event.category, event.description, event.occurredAt, now, now, NONCE_SOURCE, event.sourceId, event.version).run();
  if (wrote.meta.changes === 0) {
    const again = await loadStored(db, userId, event.sourceId);
    if (!again) return unavailable;
    return versionResult(again.source_version, event.version);
  }
  await reconcileManual(db, userId, id, now);
  return { status: 200, body: { ok: true, applied: true } };
}

async function applyDelete(db: D1Like, userId: string, event: DeleteEvent, now: number): Promise<SyncResult> {
  const current = await loadStored(db, userId, event.sourceId);
  if (current && current.source_version != null && Number(current.source_version) >= event.version) return versionResult(current.source_version, event.version);
  if (!current) {
    // Nothing to delete. Remember the version in a side table (no financial row, no account) so a late older upsert cannot create it.
    await db.prepare(
      "INSERT INTO integration_tombstones (source, source_id, user_id, version, ts) VALUES (?,?,?,?,?) ON CONFLICT(source, source_id) DO UPDATE SET version=excluded.version, ts=excluded.ts WHERE integration_tombstones.version < excluded.version",
    ).bind(NONCE_SOURCE, event.sourceId, userId, event.version, now).run();
    return { status: 200, body: { ok: true, applied: false, reason: "unseen" } };
  }
  const wrote = await db.prepare(
    "UPDATE financial_transactions SET deleted_at=?, source_version=?, updated_at=?, linked_to=NULL, link_suppressed=NULL, excluded_from_totals=0 WHERE id=? AND user_id=? AND source=? AND (source_version IS NULL OR source_version < ?)",
  ).bind(now, event.version, now, current.id, userId, NONCE_SOURCE, event.version).run();
  if (wrote.meta.changes === 0) {
    const again = await loadStored(db, userId, event.sourceId);
    if (!again) return unavailable;
    return versionResult(again.source_version, event.version);
  }
  if (current.linked_to) await clearCounterpart(db, userId, current.linked_to, now);
  return { status: 200, body: { ok: true, applied: true } };
}

/**
 * Auth order: secret + well-formed headers, timestamp window, signature, then nonce.
 * Every failure before a valid signature is 401 with the same body. The nonce is stored
 * only after the signature checks out. Replay of that nonce is 401.
 */
export async function handleCuentixEvent(db: D1Like, input: CuentixSyncInput): Promise<SyncResult> {
  if (!input.secret || !syncHeadersWellFormed(input.timestamp, input.nonce, input.signature)) return unauthorized;
  if (!syncTimestampFresh(input.timestamp!, input.now)) return unauthorized;
  const signed = await verifySyncSignature(input.secret, input.timestamp!, input.nonce!, input.rawBody, input.signature!);
  if (!signed) return unauthorized;
  try {
    await runBatch(db, [
      db.prepare("DELETE FROM integration_nonces WHERE source=? AND ts<?").bind(NONCE_SOURCE, input.now - NONCE_TTL_MS),
      db.prepare("INSERT INTO integration_nonces (source, nonce, ts) VALUES (?,?,?)").bind(NONCE_SOURCE, input.nonce, Number(input.timestamp)),
    ]);
  } catch (error) {
    if (isNonceReplay(error)) return unauthorized;
    console.error("cuentix_sync_failed");
    return unavailable;
  }
  const parsed = parseSyncEvent(input.rawBody);
  if (!parsed.ok) return invalid;
  const email = input.ownerEmail?.trim().toLowerCase() ?? "";
  if (!email) return forbidden;
  try {
    const owner = await db.prepare("SELECT id, role, approvalStatus, encryption_mode FROM user WHERE lower(email)=? LIMIT 1").bind(email).first<OwnerRow>();
    // The mode is passed through. ownerIsSyncable accepts only an explicit "server".
    if (!owner || !ownerIsSyncable({ role: owner.role, approvalStatus: owner.approvalStatus, encryptionEnabled: owner.encryption_mode })) return forbidden;
    if (parsed.event.type === "delete") return await applyDelete(db, owner.id, parsed.event, input.now);
    return await applyUpsert(db, owner.id, parsed.event, input.now);
  } catch {
    console.error("cuentix_sync_failed");
    return unavailable;
  }
}
