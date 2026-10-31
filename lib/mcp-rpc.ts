// Serpix McpRpc. Pure logic (no Next.js or Cloudflare imports) so node:test can load it.
import type { D1Like } from "./finance.ts";
import { resolveOwner } from "./mailtox-link.ts";
import { isDateKey } from "./recurring.ts";

export type RpcErrorCode = "no_owner" | "encrypted_account" | "invalid" | "not_found" | "not_enabled" | "internal";
export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: RpcErrorCode; message: string } };
export type Page<T> = { items: T[]; nextOffset: number | null };

export type Contact = {
  id: string;
  kind: "person" | "company";
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  metEvent: string | null;
  metEventAt: string | null;
  metNote: string | null;
  updatedAt: number;
};
export type Task = {
  id: string;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  dueDate: string | null;
  contactId: string | null;
  updatedAt: number;
};
export type AgendaEvent = {
  id: string;
  title: string;
  body: string | null;
  occurredAt: string;
  contactIds: string[];
  updatedAt: number;
};
export type Inquiry = {
  id: string;
  name: string;
  email: string;
  message: string;
  status: "new" | "read" | "archived";
  source: string;
  createdAt: number;
  readAt: number | null;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 200;
const NAME_MAX = 160;
const COMPANY_MAX = 160;
const EMAIL_MAX = 254;
const PHONE_MAX = 80;
const NOTES_MAX = 5000;
const MET_EVENT_MAX = 200;
const MET_NOTE_MAX = 5000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const BODY_MAX = 30000;
const WHEN_MAX = 32;
const ID_MAX = 80;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const ENCRYPTED = "encrypted account, not readable server-side";

const CONTACT_KINDS = ["person", "company"] as const;
const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const INQUIRY_STATUSES = ["new", "read", "archived"] as const;

const WHEN_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Agenda day: first 10 chars after a space is treated as `T` (same as app/agenda.tsx). */
const DAY_EXPR = "substr(replace(a.occurred_at, ' ', 'T'), 1, 10)";
/**
 * Wall clock the agenda shows (YYYY-MM-DDTHH:mm[:ss]), padded so a date-only value is midnight
 * and `YYYY-MM-DDTHH:mm` compares equal to the same minute with seconds.
 */
const CLOCK_EXPR = "(CASE WHEN length(replace(a.occurred_at, ' ', 'T')) <= 10 THEN substr(replace(a.occurred_at, ' ', 'T'), 1, 10) || 'T00:00:00' WHEN length(replace(a.occurred_at, ' ', 'T')) = 16 THEN replace(a.occurred_at, ' ', 'T') || ':00' ELSE substr(replace(a.occurred_at, ' ', 'T'), 1, 19) END)";

type WhenBound = { raw: string; day: string; clock: string | null };

function fail(code: RpcErrorCode, message: string): RpcResult<never> {
  return { ok: false, error: { code, message } };
}

function invalid(message: string): RpcResult<never> {
  return fail("invalid", message);
}

function internal(): RpcResult<never> {
  return fail("internal", "internal error");
}

function ok<T>(data: T): RpcResult<T> {
  return { ok: true, data };
}

async function run<T>(body: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await body();
  } catch {
    return internal();
  }
}

function record(input: unknown): Record<string, unknown> | null {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

async function ownerId(db: D1Like, ownerEmail: string | undefined): Promise<{ ok: true; userId: string } | { ok: false; result: RpcResult<never> }> {
  const gate = await resolveOwner(db, ownerEmail);
  if (gate.ok) return gate;
  if (gate.status === "skipped_e2e") return { ok: false, result: fail("encrypted_account", ENCRYPTED) };
  return { ok: false, result: fail("no_owner", "no owner") };
}

function parsePage(input: Record<string, unknown>): { ok: true; limit: number; offset: number } | { ok: false; message: string } {
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, message: "invalid limit" };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || !Number.isSafeInteger(offset)) return { ok: false, message: "invalid offset" };
  return { ok: true, limit, offset };
}

function parseQuery(value: unknown): { ok: true; query: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "invalid query" };
  const query = value.trim();
  if (query.length < 1 || query.length > MAX_QUERY) return { ok: false, message: "invalid query" };
  return { ok: true, query };
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): { ok: true; value?: T } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) return { ok: false, message: "invalid " + label };
  return { ok: true, value: value as T };
}

/** `%query%` with `\`, `%` and `_` escaped so LIKE treats them as literal characters. */
function likePattern(query: string): string {
  return "%" + query.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
}

function likeAny(columns: readonly string[], binds: unknown[], query: string): string {
  const pattern = likePattern(query);
  const parts = columns.map((column) => "lower(ifnull(" + column + ", '')) LIKE lower(?) ESCAPE '\\'");
  for (let i = 0; i < columns.length; i++) binds.push(pattern);
  return "(" + parts.join(" OR ") + ")";
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  return num(value);
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function parseWhen(value: unknown): WhenBound | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > WHEN_MAX) return null;
  const match = WHEN_RE.exec(raw);
  if (!match || !isDateKey(match[1])) return null;
  if (match[2] === undefined) return { raw, day: match[1], clock: null };
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const clock = match[1] + "T" + match[2] + ":" + match[3] + ":" + String(second).padStart(2, "0");
  return { raw, day: match[1], clock };
}

function dayNumber(day: string): number {
  return Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS);
}

function rangeOk(from: WhenBound, to: WhenBound): boolean {
  const span = dayNumber(to.day) - dayNumber(from.day);
  if (span < 0 || span > MAX_RANGE_DAYS) return false;
  const start = from.clock ?? from.day + "T00:00:00";
  const end = to.clock ?? to.day + "T23:59:59";
  return start <= end;
}

function pushRange(where: string[], binds: unknown[], from?: WhenBound, to?: WhenBound): void {
  if (from) {
    if (from.clock) {
      where.push(CLOCK_EXPR + " >= ?");
      binds.push(from.clock);
    } else {
      where.push(DAY_EXPR + " >= ?");
      binds.push(from.day);
    }
  }
  if (to) {
    if (to.clock) {
      where.push(CLOCK_EXPR + " <= ?");
      binds.push(to.clock);
    } else {
      where.push(DAY_EXPR + " <= ?");
      binds.push(to.day);
    }
  }
}

function optionalWhen(input: Record<string, unknown>, key: string): { ok: true; value?: WhenBound } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined) return { ok: true };
  const value = parseWhen(input[key]);
  if (!value) return { ok: false };
  return { ok: true, value };
}

type PageMeta = { limit: number; offset: number };

async function queryPage<T>(db: D1Like, sql: string, binds: unknown[], page: PageMeta): Promise<{ rows: T[]; nextOffset: number | null }> {
  const rows = (await db.prepare(sql).bind(...binds, page.limit + 1, page.offset).all<T>()).results ?? [];
  const more = rows.length > page.limit;
  return { rows: more ? rows.slice(0, page.limit) : rows, nextOffset: more ? page.offset + page.limit : null };
}

function requiredText(value: unknown, max: number, label: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text || text.length > max) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalDate(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (!isDateKey(text)) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalText(value: unknown, max: number, label: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > max) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalId(value: unknown): { ok: true; id: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, id: null };
  if (typeof value !== "string") return { ok: false };
  const id = value.trim();
  if (!id) return { ok: true, id: null };
  if (id.length > ID_MAX) return { ok: false };
  return { ok: true, id };
}

async function contactOwned(db: D1Like, userId: string, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(id, userId).first<{ id: string }>();
  return row != null;
}

type ContactRow = { id: string; kind: string; name: string; company: string | null; email: string | null; phone: string | null; notes: string | null; metEvent: string | null; metEventAt: string | null; metNote: string | null; updatedAt: number | bigint };
type TaskRow = { id: string; title: string; description: string | null; status: string; priority: string; dueDate: string | null; contactId: string | null; updatedAt: number | bigint };
type EventRow = { id: string; title: string; body: string | null; occurredAt: string; updatedAt: number | bigint };
type InquiryRow = { id: string; name: string; email: string; message: string; status: string; source: string; createdAt: number | bigint; readAt: number | bigint | null };

function mapContact(row: ContactRow): Contact {
  const kind = row.kind === "company" ? "company" : "person";
  return {
    id: String(row.id),
    kind,
    name: String(row.name),
    company: textOrNull(row.company),
    email: textOrNull(row.email),
    phone: textOrNull(row.phone),
    notes: textOrNull(row.notes),
    metEvent: textOrNull(row.metEvent),
    metEventAt: textOrNull(row.metEventAt),
    metNote: textOrNull(row.metNote),
    updatedAt: num(row.updatedAt),
  };
}

function mapTask(row: TaskRow): Task {
  const status = (TASK_STATUSES as readonly string[]).includes(row.status) ? row.status as Task["status"] : "todo";
  const priority = (TASK_PRIORITIES as readonly string[]).includes(row.priority) ? row.priority as Task["priority"] : "normal";
  return {
    id: String(row.id),
    title: String(row.title),
    description: textOrNull(row.description),
    status,
    priority,
    dueDate: textOrNull(row.dueDate),
    contactId: textOrNull(row.contactId),
    updatedAt: num(row.updatedAt),
  };
}

function mapInquiry(row: InquiryRow): Inquiry {
  const status = (INQUIRY_STATUSES as readonly string[]).includes(row.status) ? row.status as Inquiry["status"] : "new";
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    message: String(row.message),
    status,
    source: String(row.source),
    createdAt: num(row.createdAt),
    readAt: numOrNull(row.readAt),
  };
}

const CONTACT_SELECT = "SELECT id, kind, name, company_name AS company, email, phone, notes, met_event AS metEvent, met_event_at AS metEventAt, met_note AS metNote, updated_at AS updatedAt FROM contacts";
const TASK_SELECT = "SELECT id, title, description, status, priority, due_date AS dueDate, contact_id AS contactId, updated_at AS updatedAt FROM tasks";
const EVENT_SELECT = "SELECT a.id, a.title, a.body, a.occurred_at AS occurredAt, a.updated_at AS updatedAt FROM activities a";
const INQUIRY_SELECT = "SELECT id, name, email, message, status, source, created_at AS createdAt, read_at AS readAt FROM inquiries";

async function contactIdsFor(db: D1Like, userId: string, activityIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (activityIds.length === 0) return map;
  const marks = activityIds.map(() => "?").join(",");
  const rows = (await db.prepare(
    "SELECT ac.activity_id AS activityId, ac.contact_id AS contactId FROM activity_contacts ac JOIN contacts c ON c.id = ac.contact_id AND c.user_id = ac.user_id WHERE ac.user_id=? AND ac.activity_id IN (" + marks + ") ORDER BY ac.activity_id, ac.contact_id",
  ).bind(userId, ...activityIds).all<{ activityId: string; contactId: string }>()).results ?? [];
  for (const row of rows) {
    const list = map.get(String(row.activityId));
    if (list) list.push(String(row.contactId));
    else map.set(String(row.activityId), [String(row.contactId)]);
  }
  return map;
}

async function mapEvents(db: D1Like, userId: string, rows: EventRow[]): Promise<AgendaEvent[]> {
  const links = await contactIdsFor(db, userId, rows.map((row) => String(row.id)));
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    body: textOrNull(row.body),
    occurredAt: String(row.occurredAt),
    contactIds: links.get(String(row.id)) ?? [],
    updatedAt: num(row.updatedAt),
  }));
}

export async function listContacts(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Contact>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const listed = await queryPage<ContactRow>(db, CONTACT_SELECT + " WHERE user_id=? ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?", [owner.userId], page);
    return ok({ items: listed.rows.map(mapContact), nextOffset: listed.nextOffset });
  });
}

export async function searchContacts(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Contact>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const binds: unknown[] = [owner.userId];
    const match = likeAny(["name", "company_name", "email", "phone", "notes"], binds, query.query);
    const listed = await queryPage<ContactRow>(db, CONTACT_SELECT + " WHERE user_id=? AND " + match + " ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapContact), nextOffset: listed.nextOffset });
  });
}

export async function createContact(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Contact>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const name = requiredText(body.name, NAME_MAX, "name");
    if (!name.ok) return invalid(name.message);
    const kind = parseEnum(body.kind, CONTACT_KINDS, "kind");
    if (!kind.ok) return invalid(kind.message);
    const email = optionalText(body.email, EMAIL_MAX, "email");
    if (!email.ok) return invalid(email.message);
    const phone = optionalText(body.phone, PHONE_MAX, "phone");
    if (!phone.ok) return invalid(phone.message);
    const company = optionalText(body.company, COMPANY_MAX, "company");
    if (!company.ok) return invalid(company.message);
    const notes = optionalText(body.notes, NOTES_MAX, "notes");
    if (!notes.ok) return invalid(notes.message);
    const metEvent = optionalText(body.metEvent, MET_EVENT_MAX, "metEvent");
    if (!metEvent.ok) return invalid(metEvent.message);
    const metNote = optionalText(body.metNote, MET_NOTE_MAX, "metNote");
    if (!metNote.ok) return invalid(metNote.message);
    const metEventAt = optionalDate(body.metEventAt, "metEventAt");
    if (!metEventAt.ok) return invalid(metEventAt.message);
    const id = crypto.randomUUID();
    const now = Date.now();
    const storedKind = kind.value ?? "person";
    await db.prepare(
      "INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,met_event,met_event_at,met_note,is_potential,role,relations,github_url,x_url,instagram_url,telegram_url,whatsapp_url,linkedin_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, owner.userId, storedKind, name.value, company.value, email.value, phone.value, notes.value, metEvent.value, metEventAt.value, metNote.value, 0, "potential", "{}", null, null, null, null, null, null, now, now).run();
    return ok({ id, kind: storedKind, name: name.value, company: company.value, email: email.value, phone: phone.value, notes: notes.value, metEvent: metEvent.value, metEventAt: metEventAt.value, metNote: metNote.value, updatedAt: now });
  });
}

export async function listTasks(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Task>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    const listed = await queryPage<TaskRow>(
      db,
      TASK_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_date, id LIMIT ? OFFSET ?",
      binds,
      page,
    );
    return ok({ items: listed.rows.map(mapTask), nextOffset: listed.nextOffset });
  });
}

export async function searchTasks(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Task>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    where.push(likeAny(["title", "description"], binds, query.query));
    const listed = await queryPage<TaskRow>(
      db,
      TASK_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_date, id LIMIT ? OFFSET ?",
      binds,
      page,
    );
    return ok({ items: listed.rows.map(mapTask), nextOffset: listed.nextOffset });
  });
}

export async function createTask(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Task>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const title = requiredText(body.title, TITLE_MAX, "title");
    if (!title.ok) return invalid(title.message);
    const description = optionalText(body.description, DESCRIPTION_MAX, "description");
    if (!description.ok) return invalid(description.message);
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const priority = parseEnum(body.priority, TASK_PRIORITIES, "priority");
    if (!priority.ok) return invalid(priority.message);
    const due = optionalText(body.dueDate, 10, "due date");
    if (!due.ok) return invalid(due.message);
    if (due.value !== null && !isDateKey(due.value)) return invalid("invalid due date");
    const contact = optionalId(body.contactId);
    if (!contact.ok) return invalid("invalid contact");
    if (contact.id && !(await contactOwned(db, owner.userId, contact.id))) return invalid("invalid contact");
    const id = crypto.randomUUID();
    const now = Date.now();
    const storedStatus = status.value ?? "todo";
    const storedPriority = priority.value ?? "normal";
    await db.prepare(
      "INSERT INTO tasks (id,user_id,project_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, owner.userId, null, contact.id, title.value, description.value, storedStatus, storedPriority, due.value, now, now).run();
    return ok({
      id,
      title: title.value,
      description: description.value,
      status: storedStatus,
      priority: storedPriority,
      dueDate: due.value,
      contactId: contact.id,
      updatedAt: now,
    });
  });
}

async function eventPage(db: D1Like, userId: string, where: string[], binds: unknown[], page: PageMeta): Promise<Page<AgendaEvent>> {
  const listed = await queryPage<EventRow>(
    db,
    EVENT_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY " + CLOCK_EXPR + " DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?",
    binds,
    page,
  );
  return { items: await mapEvents(db, userId, listed.rows), nextOffset: listed.nextOffset };
}

export async function listEvents(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<AgendaEvent>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const from = parseWhen(body.from);
    const to = parseWhen(body.to);
    if (!from || !to || !rangeOk(from, to)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='event'"];
    const binds: unknown[] = [owner.userId];
    pushRange(where, binds, from, to);
    return ok(await eventPage(db, owner.userId, where, binds, page));
  });
}

export async function searchEvents(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<AgendaEvent>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const from = optionalWhen(body, "from");
    if (!from.ok) return invalid("invalid date range");
    const to = optionalWhen(body, "to");
    if (!to.ok) return invalid("invalid date range");
    if (from.value && to.value && !rangeOk(from.value, to.value)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='event'"];
    const binds: unknown[] = [owner.userId];
    pushRange(where, binds, from.value, to.value);
    where.push(likeAny(["a.title", "a.body"], binds, query.query));
    return ok(await eventPage(db, owner.userId, where, binds, page));
  });
}

export async function createEvent(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<AgendaEvent>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const title = requiredText(body.title, TITLE_MAX, "title");
    if (!title.ok) return invalid(title.message);
    const when = parseWhen(body.occurredAt);
    if (!when) return invalid("invalid occurredAt");
    const notes = optionalText(body.body, BODY_MAX, "body");
    if (!notes.ok) return invalid(notes.message);
    const contactIds: string[] = [];
    if (body.contactIds !== undefined) {
      if (!Array.isArray(body.contactIds)) return invalid("invalid contact");
      const seen = new Set<string>();
      for (const value of body.contactIds) {
        if (typeof value !== "string") return invalid("invalid contact");
        const id = value.trim();
        if (!id || seen.has(id)) continue;
        if (id.length > ID_MAX) return invalid("invalid contact");
        seen.add(id);
        contactIds.push(id);
      }
    }
    if (contactIds.length > 0) {
      const marks = contactIds.map(() => "?").join(",");
      const linked = await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN (" + marks + ")").bind(owner.userId, ...contactIds).first<{ count: number | bigint }>();
      if (Number(linked?.count ?? 0) !== contactIds.length) return invalid("invalid contact");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const insert = db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, owner.userId, "event", title.value, notes.value, when.raw, now, now);
    const links = contactIds.map((contactId) => db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id, contactId, owner.userId));
    const statements = [insert, ...links];
    const wrote = db.batch ? await db.batch(statements) : await Promise.all(statements.map((statement) => statement.run()));
    if ((wrote[0]?.meta.changes ?? 0) < 1) return internal();
    return ok({ id, title: title.value, body: notes.value, occurredAt: when.raw, contactIds, updatedAt: now });
  });
}

export async function listInquiries(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Inquiry>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const status = parseEnum(body.status, INQUIRY_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    const listed = await queryPage<InquiryRow>(db, INQUIRY_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapInquiry), nextOffset: listed.nextOffset });
  });
}

export async function searchInquiries(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Inquiry>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const status = parseEnum(body.status, INQUIRY_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    where.push(likeAny(["name", "email", "message"], binds, query.query));
    const listed = await queryPage<InquiryRow>(db, INQUIRY_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapInquiry), nextOffset: listed.nextOffset });
  });
}
