// Mailtox -> Serpix contact sync. Pure logic (no Next.js or Cloudflare imports) so node:test can load it.
import type { D1Like } from "./finance.ts";

/** Keyset page size for listContactsWithEmail. */
export const CONTACT_PAGE_SIZE = 200;

const NAME_MAX = 160;
const EMAIL_MAX = 254;
const PHONE_MAX = 80;
const COMPANY_MAX = 160;
const LOCAL_MAX = 64;

export type MailContact = { email: string; name: string; id: string; updatedAt: number };
export type ContactPage = { contacts: MailContact[]; nextCursor: string | null };
export type UpsertInput = { email: string; name?: string; phone?: string; company?: string };
export type UpsertResult = { status: "created" | "exists" | "skipped_e2e" | "invalid" | "no_owner"; id?: string };

/**
 * Trim, NFKC, strip `Name <mailbox>`, lowercase.
 * Null when it is not a single reasonable mailbox (no spaces, one @, <= 254, domain has a dot).
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().normalize("NFKC").trim();
  const angled = /<([^<>]+)>/.exec(value);
  if (angled) value = angled[1].trim().normalize("NFKC").trim();
  value = value.toLowerCase();
  if (!value || value.length > EMAIL_MAX || /\s/.test(value)) return null;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || local.length > LOCAL_MAX || !domain || domain.length > 253) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  if (!domain.includes(".")) return null;
  if (domain.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  return value;
}

/**
 * Match policy, applied to both the stored contact and the incoming address:
 * normalized mailbox, then (a) drop the `+tag` from the local part on every domain
 * (`foo+news@x` == `foo@x`) and (b) only for gmail.com / googlemail.com, drop dots in the
 * local part and map googlemail.com -> gmail.com. Other domains keep their dots.
 * Null when normalization fails or the local part is empty after stripping.
 */
export function matchKey(raw: unknown): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  const at = email.indexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  if (!local) return null;
  return local + "@" + domain;
}

/**
 * SQLite expression with the same result as matchKey() for ASCII mailbox text (no NFKC).
 * Used by the insert guard so two concurrent upserts of the same key cannot both insert.
 */
export function emailMatchExpr(ref: string): string {
  const trimmed = `trim(${ref})`;
  const lt = `instr(${trimmed}, '<')`;
  const gt = `instr(${trimmed}, '>')`;
  const inside = `substr(${trimmed}, ${lt} + 1, ${gt} - ${lt} - 1)`;
  const addr = `lower(trim(CASE WHEN ${lt} > 0 AND ${gt} > ${lt} THEN ${inside} ELSE ${trimmed} END))`;
  const at = `instr(${addr}, '@')`;
  const local = `(CASE WHEN ${at} > 0 THEN substr(${addr}, 1, ${at} - 1) ELSE '' END)`;
  const domain = `(CASE WHEN ${at} > 0 THEN substr(${addr}, ${at} + 1) ELSE '' END)`;
  const plus = `instr(${local}, '+')`;
  const localNoTag = `(CASE WHEN ${plus} > 0 THEN substr(${local}, 1, ${plus} - 1) ELSE ${local} END)`;
  return `(CASE WHEN ${domain} = 'gmail.com' OR ${domain} = 'googlemail.com' THEN replace(${localNoTag}, '.', '') || '@gmail.com' ELSE ${localNoTag} || '@' || ${domain} END)`;
}

type OwnerRow = { id: string; role: string; approvalStatus: string };
type ContactRow = { id: string; name: string; email: string; updatedAt: number | bigint };

let encryptionModeColumn: boolean | null = null;

/** Tests add `user.encryption_mode` on a fresh database; the isolate cache must be cleared. */
export function resetEncryptionModeCache(): void {
  encryptionModeColumn = null;
}

async function hasEncryptionModeColumn(db: D1Like): Promise<boolean> {
  if (encryptionModeColumn !== null) return encryptionModeColumn;
  const row = await db.prepare("SELECT 1 FROM pragma_table_info('user') WHERE name='encryption_mode'").bind().first();
  encryptionModeColumn = row != null;
  return encryptionModeColumn;
}

/**
 * Fail closed when this account is not server-readable.
 * On the E2E branch, contact mailboxes live inside encrypted `records`, not cleartext `contacts`.
 * Listing or inserting a cleartext email would leak the address (or write a row the account cannot own).
 * NULL and any value other than 'server' are treated as not server.
 */
async function e2eBlocks(db: D1Like, userId: string): Promise<boolean> {
  if (!(await hasEncryptionModeColumn(db))) return false;
  const row = await db.prepare("SELECT encryption_mode AS mode FROM user WHERE id=?").bind(userId).first<{ mode: string | null }>();
  return row?.mode !== "server";
}

type Gate = { ok: true; userId: string } | { ok: false; status: "no_owner" | "skipped_e2e" };

async function resolveOwner(db: D1Like, ownerEmail: string | undefined): Promise<Gate> {
  const email = ownerEmail?.trim().toLowerCase() ?? "";
  if (!email) return { ok: false, status: "no_owner" };
  const owner = await db.prepare("SELECT id, role, approvalStatus FROM user WHERE lower(email)=?").bind(email).first<OwnerRow>();
  if (!owner || owner.role !== "admin" || owner.approvalStatus !== "approved") return { ok: false, status: "no_owner" };
  if (await e2eBlocks(db, owner.id)) return { ok: false, status: "skipped_e2e" };
  return { ok: true, userId: owner.id };
}

function emptyPage(): ContactPage {
  return { contacts: [], nextCursor: null };
}

function parseCursor(cursor: string | null | undefined): { updatedAt: number; id: string } | null {
  if (cursor == null) return null;
  const text = cursor.trim();
  if (!text) return null;
  const sep = text.indexOf(":");
  if (sep <= 0) return null;
  const updatedAt = Number(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (!id || !Number.isSafeInteger(updatedAt)) return null;
  return { updatedAt, id };
}

function cursorOf(row: { id: string; updatedAt: number | bigint }): string {
  const updatedAt = Number(row.updatedAt);
  return (Number.isFinite(updatedAt) ? updatedAt : 0) + ":" + row.id;
}

function listed(row: ContactRow): MailContact | null {
  const email = normalizeEmail(row.email);
  if (!email) return null;
  const updatedAt = Number(row.updatedAt);
  return { email, name: row.name == null ? "" : String(row.name), id: String(row.id), updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
}

export async function listContactsWithEmail(db: D1Like, ownerEmail: string | undefined, sinceCursor?: string | null): Promise<ContactPage> {
  const gate = await resolveOwner(db, ownerEmail);
  if (!gate.ok) return emptyPage();
  const cursor = parseCursor(sinceCursor);
  const sql = cursor
    ? "SELECT id, name, email, updated_at AS updatedAt FROM contacts WHERE user_id=? AND email IS NOT NULL AND trim(email)<>'' AND (updated_at>? OR (updated_at=? AND id>?)) ORDER BY updated_at ASC, id ASC LIMIT ?"
    : "SELECT id, name, email, updated_at AS updatedAt FROM contacts WHERE user_id=? AND email IS NOT NULL AND trim(email)<>'' ORDER BY updated_at ASC, id ASC LIMIT ?";
  const bound = cursor
    ? db.prepare(sql).bind(gate.userId, cursor.updatedAt, cursor.updatedAt, cursor.id, CONTACT_PAGE_SIZE + 1)
    : db.prepare(sql).bind(gate.userId, CONTACT_PAGE_SIZE + 1);
  const rows = (await bound.all<ContactRow>()).results ?? [];
  const more = rows.length > CONTACT_PAGE_SIZE;
  const window = more ? rows.slice(0, CONTACT_PAGE_SIZE) : rows;
  const contacts: MailContact[] = [];
  for (const row of window) {
    const item = listed(row);
    if (item) contacts.push(item);
  }
  return { contacts, nextCursor: more ? cursorOf(window[window.length - 1]!) : null };
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

function providedName(value: unknown): string | null {
  return clip(value, NAME_MAX);
}

const INSERT_SQL = "INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,is_potential,role,relations,github_url,x_url,instagram_url,telegram_url,whatsapp_url,linkedin_url,created_at,updated_at) SELECT ?,?,'person',?,?,?,?,NULL,0,'potential','{}',NULL,NULL,NULL,NULL,NULL,NULL,?,? WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.user_id=? AND c.email IS NOT NULL AND trim(c.email)<>'' AND " + emailMatchExpr("c.email") + "=?)";

async function findByMatchKey(db: D1Like, userId: string, key: string): Promise<{ id: string; name: string } | null> {
  const rows = (await db.prepare("SELECT id, name, email FROM contacts WHERE user_id=? AND email IS NOT NULL AND trim(email)<>'' ORDER BY updated_at ASC, id ASC").bind(userId).all<{ id: string; name: string; email: string }>()).results ?? [];
  for (const row of rows) {
    if (matchKey(row.email) === key) return { id: row.id, name: row.name ?? "" };
  }
  return null;
}

async function fillEmptyName(db: D1Like, userId: string, id: string, name: string | null): Promise<void> {
  if (!name) return;
  await db.prepare("UPDATE contacts SET name=?, updated_at=? WHERE id=? AND user_id=? AND trim(name)=''").bind(name, Date.now(), id, userId).run();
}

export async function upsertContactByEmail(db: D1Like, ownerEmail: string | undefined, input: UpsertInput): Promise<UpsertResult> {
  const gate = await resolveOwner(db, ownerEmail);
  if (!gate.ok) return { status: gate.status };
  const email = normalizeEmail(input?.email);
  const key = email ? matchKey(email) : null;
  if (!email || !key) return { status: "invalid" };
  const name = providedName(input?.name) ?? email.slice(0, email.indexOf("@")).slice(0, NAME_MAX);
  if (!name) return { status: "invalid" };
  const phone = clip(input?.phone, PHONE_MAX);
  const company = clip(input?.company, COMPANY_MAX);
  const existing = await findByMatchKey(db, gate.userId, key);
  if (existing) {
    await fillEmptyName(db, gate.userId, existing.id, providedName(input?.name));
    return { status: "exists", id: existing.id };
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const wrote = await db.prepare(INSERT_SQL).bind(id, gate.userId, name, company, email, phone, now, now, gate.userId, key).run();
  if (wrote.meta.changes > 0) return { status: "created", id };
  const raced = await findByMatchKey(db, gate.userId, key);
  if (raced) {
    await fillEmptyName(db, gate.userId, raced.id, providedName(input?.name));
    return { status: "exists", id: raced.id };
  }
  throw new Error("mailtox_link_conflict");
}
