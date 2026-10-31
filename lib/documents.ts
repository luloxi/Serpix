// Presupuestos y facturas (comprobantes internos, NO fiscales). Pure helpers + D1 operations; no Next.js or Cloudflare imports so node:test can load them.
import type { D1Bound } from "./finance.ts";

export const DOC_TYPES = ["quote", "invoice"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const STATUSES = ["draft", "sent", "paid", "void"] as const;
export type DocStatus = (typeof STATUSES)[number];
export type DocCurrency = "ARS" | "USD";
export const MAX_ITEMS = 100;
export const DEFAULT_DUE_DAYS = 15;

export type DocItemInput = { description: string; quantityMilli: number; unitPriceMinor: number; timeEntryId?: string | null };
export type DocInput = {
  type: DocType;
  contactId: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: DocCurrency;
  notes: string | null;
  items: DocItemInput[];
};

export type DocDb = {
  prepare(sql: string): { bind(...values: unknown[]): D1Bound };
};
export type Result<T = Record<string, unknown>> = { status: number; body: T & { error?: string; ok?: boolean } };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "F-0007" for invoices, "P-0003" for quotes. */
export function formatNumber(type: DocType, n: number): string {
  return (type === "invoice" ? "F-" : "P-") + String(n).padStart(4, "0");
}
export const typeLabel = (t: DocType) => (t === "invoice" ? "Factura" : "Presupuesto");

/** quantity (x1000) * unit price (minor units), rounded to a whole minor unit. */
export function lineTotalMinor(quantityMilli: number, unitPriceMinor: number): number {
  return Math.round((quantityMilli * unitPriceMinor) / 1000);
}
export function itemsTotalMinor(items: { quantityMilli: number; unitPriceMinor: number }[]): number {
  return items.reduce((sum, i) => sum + lineTotalMinor(i.quantityMilli, i.unitPriceMinor), 0);
}

/** An invoice that was sent, is not paid and whose due date is before today. Stored status stays "sent". */
export function isOverdue(doc: { type: DocType; status: string; dueDate: string | null }, today: string): boolean {
  return doc.type === "invoice" && doc.status === "sent" && !!doc.dueDate && doc.dueDate < today;
}
export type DisplayStatus = DocStatus | "overdue";
export function displayStatus(doc: { type: DocType; status: DocStatus; dueDate: string | null }, today: string): DisplayStatus {
  return isOverdue(doc, today) ? "overdue" : doc.status;
}
export const STATUS_LABEL: Record<DisplayStatus, string> = { draft: "Borrador", sent: "Enviada", paid: "Cobrada", overdue: "Vencida", void: "Anulada" };

export function parseItem(raw: unknown): DocItemInput | string {
  if (!raw || typeof raw !== "object") return "Ítem inválido";
  const r = raw as Record<string, unknown>;
  const description = str(r.description, 300);
  if (!description) return "Cada ítem necesita una descripción";
  const q = r.quantityMilli, p = r.unitPriceMinor;
  if (typeof q !== "number" || !Number.isSafeInteger(q) || q <= 0 || q > 100_000_000) return "Cantidad inválida";
  if (typeof p !== "number" || !Number.isSafeInteger(p) || p < 0 || p > 1_000_000_000_000) return "Precio inválido";
  const timeEntryId = typeof r.timeEntryId === "string" && r.timeEntryId ? r.timeEntryId.slice(0, 80) : null;
  return { description, quantityMilli: q, unitPriceMinor: p, timeEntryId };
}

/** Validates a create/update body. `today` fills a missing issue date. */
export function parseDocInput(raw: unknown, today: string): { ok: true; value: DocInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Cuerpo inválido" };
  const b = raw as Record<string, unknown>;
  const type = DOC_TYPES.find((t) => t === b.type);
  if (!type) return { ok: false, error: "Tipo inválido" };
  const currency: DocCurrency | null = b.currency === "USD" ? "USD" : b.currency === "ARS" ? "ARS" : null;
  if (!currency) return { ok: false, error: "Moneda inválida" };
  const issueDate = b.issueDate === undefined || b.issueDate === "" || b.issueDate === null ? today : b.issueDate;
  if (!isDate(issueDate)) return { ok: false, error: "Fecha inválida" };
  const dueRaw = b.dueDate === undefined || b.dueDate === "" || b.dueDate === null ? null : b.dueDate;
  if (dueRaw !== null && !isDate(dueRaw)) return { ok: false, error: "Vencimiento inválido" };
  if (dueRaw !== null && dueRaw < issueDate) return { ok: false, error: "El vencimiento no puede ser anterior a la fecha" };
  if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: "Agregá al menos un ítem" };
  if (b.items.length > MAX_ITEMS) return { ok: false, error: "Demasiados ítems" };
  const items: DocItemInput[] = [];
  const seen = new Set<string>();
  for (const it of b.items) {
    const p = parseItem(it);
    if (typeof p === "string") return { ok: false, error: p };
    if (p.timeEntryId) { if (seen.has(p.timeEntryId)) return { ok: false, error: "Horas repetidas" }; seen.add(p.timeEntryId); }
    items.push(p);
  }
  const total = itemsTotalMinor(items);
  if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, error: "El total tiene que ser mayor a cero" };
  const contactId = str(b.contactId, 80) || null;
  return { ok: true, value: { type, contactId, issueDate, dueDate: dueRaw as string | null, currency, notes: str(b.notes, 2000) || null, items } };
}

/** Hours from a billable time entry -> invoice item ("tarea · 2026-10-30", hours x hourly rate). */
export function itemFromTimeEntry(e: { id: string; taskTitle: string | null; description: string | null; startedAt: number; durationMs: number; hourlyRateMinor: number }): DocItemInput {
  const day = new Date(e.startedAt - 3 * 3600_000).toISOString().slice(0, 10); // America/Buenos_Aires, UTC-3
  const base = (e.taskTitle || e.description || "Horas") + " · " + day;
  const hours = Math.round((e.durationMs / 3_600_000) * 100) / 100; // two decimals
  return { description: base.slice(0, 300), quantityMilli: Math.max(10, Math.round(hours * 1000)), unitPriceMinor: e.hourlyRateMinor, timeEntryId: e.id };
}

export const LIST_SQL = "SELECT d.id, d.doc_type AS type, d.number, d.contact_id AS contactId, c.name AS contactName, c.email AS contactEmail, c.phone AS contactPhone, d.issue_date AS issueDate, d.due_date AS dueDate, d.currency, d.notes, d.status, d.source_quote_id AS sourceQuoteId, (SELECT i.id FROM documents i WHERE i.source_quote_id = d.id AND i.user_id = d.user_id) AS invoiceId, d.transaction_id AS transactionId, d.paid_at AS paidAt, d.created_at AS createdAt, COALESCE((SELECT SUM(CAST(ROUND(x.quantity_milli * x.unit_price_minor / 1000.0) AS INTEGER)) FROM document_items x WHERE x.document_id = d.id AND x.user_id = d.user_id), 0) AS totalMinor FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id AND c.user_id = d.user_id WHERE d.user_id = ?";
const ORDER_SQL = " ORDER BY d.doc_type, d.number DESC";

export async function listDocuments(db: DocDb, userId: string) {
  const r = await db.prepare(LIST_SQL + ORDER_SQL).bind(userId).all();
  return r.results ?? [];
}

type DocRow = { id: string; type: DocType; number: number; contactId: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; issueDate: string; dueDate: string | null; currency: DocCurrency; notes: string | null; status: DocStatus; sourceQuoteId: string | null; invoiceId: string | null; transactionId: string | null; paidAt: string | null; totalMinor: number };

export async function getDocument(db: DocDb, userId: string, id: string): Promise<(DocRow & { items: (DocItemInput & { id: string })[] }) | null> {
  const doc = await db.prepare(LIST_SQL + " AND d.id = ?").bind(userId, id).first<DocRow>();
  if (!doc) return null;
  const items = await db.prepare("SELECT i.id, i.description, i.quantity_milli AS quantityMilli, i.unit_price_minor AS unitPriceMinor, i.time_entry_id AS timeEntryId FROM document_items i WHERE i.document_id = ? AND i.user_id = ? ORDER BY i.position").bind(id, userId).all<DocItemInput & { id: string }>();
  return { ...doc, items: items.results ?? [] };
}

async function checkRefs(db: DocDb, userId: string, input: DocInput, docId: string | null): Promise<string | null> {
  if (input.contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(input.contactId, userId).first())) return "Contacto inválido";
  for (const it of input.items) {
    if (!it.timeEntryId) continue;
    const e = await db.prepare("SELECT e.id, e.currency FROM time_entries e WHERE e.id=? AND e.user_id=? AND e.billable=1").bind(it.timeEntryId, userId).first<{ id: string; currency: string }>();
    if (!e) return "Horas inválidas";
    if (e.currency !== input.currency) return "Las horas están en otra moneda";
    const link = await db.prepare("SELECT document_id AS documentId FROM document_time_entries WHERE time_entry_id=? AND user_id=?").bind(it.timeEntryId, userId).first<{ documentId: string }>();
    if (link && link.documentId !== docId) return "Esas horas ya están en otro comprobante";
  }
  return null;
}

async function writeItems(db: DocDb, userId: string, docId: string, items: DocItemInput[]) {
  await db.prepare("DELETE FROM document_time_entries WHERE document_id=? AND user_id=?").bind(docId, userId).run();
  await db.prepare("DELETE FROM document_items WHERE document_id=? AND user_id=?").bind(docId, userId).run();
  let pos = 0;
  for (const it of items) {
    await db.prepare("INSERT INTO document_items (id,document_id,position,description,quantity_milli,unit_price_minor,time_entry_id,user_id) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), docId, pos++, it.description, it.quantityMilli, it.unitPriceMinor, it.timeEntryId ?? null, userId).run();
    if (it.timeEntryId) await db.prepare("INSERT OR IGNORE INTO document_time_entries (time_entry_id, document_id, user_id) VALUES (?,?,?)").bind(it.timeEntryId, docId, userId).run();
  }
}

/** Inserts the document with the next correlative number for (user, type) in ONE statement (atomic in SQLite). */
async function insertDoc(db: DocDb, userId: string, id: string, input: DocInput, extra: { sourceQuoteId?: string | null }, now: number): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO documents (id,user_id,doc_type,number,contact_id,issue_date,due_date,currency,notes,status,source_quote_id,created_at,updated_at) " +
    "SELECT ?,?,?,COALESCE(MAX(number),0)+1,?,?,?,?,?,'draft',?,?,? FROM documents WHERE user_id=? AND doc_type=?",
  ).bind(id, userId, input.type, input.contactId, input.issueDate, input.dueDate, input.currency, input.notes, extra.sourceQuoteId ?? null, now, now, userId, input.type).run();
  if (r.meta.changes !== 1) throw new Error("document_insert_failed");
  const row = await db.prepare("SELECT number FROM documents WHERE id=? AND user_id=?").bind(id, userId).first<{ number: number }>();
  return row?.number ?? 0;
}

export async function createDocument(db: DocDb, userId: string, input: DocInput, now: number, extra: { sourceQuoteId?: string | null } = {}): Promise<Result<{ id?: string; number?: number }>> {
  const bad = await checkRefs(db, userId, input, null);
  if (bad) return { status: 400, body: { error: bad } };
  const id = crypto.randomUUID();
  const number = await insertDoc(db, userId, id, input, extra, now);
  try {
    await writeItems(db, userId, id, input.items);
  } catch (e) {
    await db.prepare("DELETE FROM documents WHERE id=? AND user_id=?").bind(id, userId).run(); // nothing half-written
    throw e;
  }
  return { status: 201, body: { ok: true, id, number } as { id: string; number: number } };
}

/** Edit a draft or sent document (paid and void ones are closed). Type and number never change. */
export async function updateDocument(db: DocDb, userId: string, id: string, input: DocInput, now: number): Promise<Result> {
  const cur = await db.prepare("SELECT doc_type AS type, status FROM documents WHERE id=? AND user_id=?").bind(id, userId).first<{ type: DocType; status: DocStatus }>();
  if (!cur) return { status: 404, body: { error: "Comprobante inexistente" } };
  if (cur.status === "paid" || cur.status === "void") return { status: 409, body: { error: "Un comprobante cobrado o anulado no se edita" } };
  if (cur.type !== input.type) return { status: 400, body: { error: "El tipo no se puede cambiar" } };
  const bad = await checkRefs(db, userId, input, id);
  if (bad) return { status: 400, body: { error: bad } };
  await db.prepare("UPDATE documents SET contact_id=?,issue_date=?,due_date=?,currency=?,notes=?,updated_at=? WHERE id=? AND user_id=? AND status IN ('draft','sent')").bind(input.contactId, input.issueDate, input.dueDate, input.currency, input.notes, now, id, userId).run();
  await writeItems(db, userId, id, input.items);
  return { status: 200, body: { ok: true } };
}

/** draft <-> sent, or void. Paid is only reachable through payDocument. */
export async function setStatus(db: DocDb, userId: string, id: string, to: "draft" | "sent" | "void", now: number): Promise<Result> {
  const cur = await db.prepare("SELECT status FROM documents WHERE id=? AND user_id=?").bind(id, userId).first<{ status: DocStatus }>();
  if (!cur) return { status: 404, body: { error: "Comprobante inexistente" } };
  if (cur.status === "paid") return { status: 409, body: { error: "Ya está cobrada" } };
  if (cur.status === "void" && to !== "void") return { status: 409, body: { error: "Está anulado" } };
  await db.prepare("UPDATE documents SET status=?, overdue_notified_on=CASE WHEN ?='sent' THEN overdue_notified_on ELSE NULL END, updated_at=? WHERE id=? AND user_id=? AND status<>'paid'").bind(to, to, now, id, userId).run();
  return { status: 200, body: { ok: true } };
}

/** Marks an invoice as paid and creates the income in Finanzas exactly once (documents.transaction_id is unique). */
export async function payDocument(db: DocDb, userId: string, id: string, accountId: string, paidAt: string, now: number): Promise<Result<{ transactionId?: string; existed?: boolean }>> {
  if (!isDate(paidAt)) return { status: 400, body: { error: "Fecha inválida" } };
  const doc = await getDocument(db, userId, id);
  if (!doc) return { status: 404, body: { error: "Comprobante inexistente" } };
  if (doc.type !== "invoice") return { status: 400, body: { error: "Solo las facturas se cobran" } };
  if (doc.status === "paid" || doc.transactionId) return { status: 200, body: { ok: true, existed: true, transactionId: doc.transactionId ?? undefined } };
  if (doc.status === "void") return { status: 409, body: { error: "Está anulada" } };
  if (doc.totalMinor <= 0) return { status: 400, body: { error: "El total tiene que ser mayor a cero" } };
  const account = await db.prepare("SELECT id, currency FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId, userId).first<{ id: string; currency: string }>();
  if (!account) return { status: 400, body: { error: "Cuenta inválida" } };
  if (account.currency !== doc.currency) return { status: 400, body: { error: "La cuenta es en " + account.currency + " y la factura en " + doc.currency } };
  const txId = crypto.randomUUID();
  const description = (typeLabel("invoice") + " " + formatNumber("invoice", doc.number) + (doc.contactName ? " · " + doc.contactName : "")).slice(0, 300);
  await db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(txId, userId, accountId, doc.contactId, "income", doc.totalMinor, "Factura", description, paidAt, now).run();
  const upd = await db.prepare("UPDATE documents SET status='paid', transaction_id=?, paid_at=?, updated_at=? WHERE id=? AND user_id=? AND status IN ('draft','sent') AND transaction_id IS NULL").bind(txId, paidAt, now, id, userId).run();
  if (upd.meta.changes === 0) {
    // Someone else paid it between the read and the write: drop the income we just made.
    await db.prepare("DELETE FROM financial_transactions WHERE id=? AND user_id=?").bind(txId, userId).run();
    return { status: 200, body: { ok: true, existed: true } };
  }
  return { status: 200, body: { ok: true, transactionId: txId } };
}

/** Quote -> invoice (draft, same items and client, due in 15 days). Idempotent: a second call returns the same invoice. */
export async function convertQuote(db: DocDb, userId: string, quoteId: string, today: string, now: number): Promise<Result<{ id?: string; number?: number; existed?: boolean }>> {
  const q = await getDocument(db, userId, quoteId);
  if (!q) return { status: 404, body: { error: "Presupuesto inexistente" } };
  if (q.type !== "quote") return { status: 400, body: { error: "Solo se convierten presupuestos" } };
  if (q.status === "void") return { status: 409, body: { error: "El presupuesto está anulado" } };
  if (q.invoiceId) {
    const inv = await db.prepare("SELECT number FROM documents WHERE id=? AND user_id=?").bind(q.invoiceId, userId).first<{ number: number }>();
    return { status: 200, body: { ok: true, id: q.invoiceId, number: inv?.number, existed: true } };
  }
  const input: DocInput = { type: "invoice", contactId: q.contactId, issueDate: today, dueDate: addDays(today, DEFAULT_DUE_DAYS), currency: q.currency, notes: q.notes, items: q.items.map((i) => ({ description: i.description, quantityMilli: i.quantityMilli, unitPriceMinor: i.unitPriceMinor, timeEntryId: null })) };
  try {
    const r = await createDocument(db, userId, input, now, { sourceQuoteId: quoteId });
    return r as Result<{ id?: string; number?: number; existed?: boolean }>;
  } catch {
    // Unique index on source_quote_id: a parallel call already converted it.
    const again = await getDocument(db, userId, quoteId);
    if (again?.invoiceId) return { status: 200, body: { ok: true, id: again.invoiceId, existed: true } };
    throw new Error("convert_failed");
  }
}

/** Only drafts can be deleted; anything that was sent is voided instead. */
export async function deleteDocument(db: DocDb, userId: string, id: string): Promise<Result> {
  const r = await db.prepare("DELETE FROM documents WHERE id=? AND user_id=? AND status='draft' AND transaction_id IS NULL").bind(id, userId).run();
  if (r.meta.changes === 0) return { status: 409, body: { error: "Solo se borran borradores; anulá el resto" } };
  return { status: 200, body: { ok: true } };
}

/** Billable hours of the client's tasks that are not in any document yet, in the document's currency. */
export async function importableTimeEntries(db: DocDb, userId: string, contactId: string, currency: string, docId: string | null) {
  const r = await db.prepare(
    "SELECT e.id, t.title AS taskTitle, e.description, e.started_at AS startedAt, e.duration_ms AS durationMs, e.hourly_rate_minor AS hourlyRateMinor, e.amount_minor AS amountMinor, e.currency FROM time_entries e JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id " +
    "WHERE e.user_id = ? AND t.contact_id = ? AND e.billable = 1 AND e.currency = ? AND e.hourly_rate_minor > 0 AND NOT EXISTS (SELECT 1 FROM document_time_entries d WHERE d.time_entry_id = e.id AND d.user_id = e.user_id AND d.document_id IS NOT ?) ORDER BY e.started_at",
  ).bind(userId, contactId, currency, docId).all<{ id: string; taskTitle: string | null; description: string | null; startedAt: number; durationMs: number; hourlyRateMinor: number; amountMinor: number; currency: string }>();
  return (r.results ?? []).map((e) => ({ ...e, item: itemFromTimeEntry(e) }));
}

/** Overdue, unpaid invoices of a user (what Resumen and the push talk about). */
export async function overdueInvoices(db: DocDb, userId: string, today: string) {
  const r = await db.prepare(LIST_SQL + " AND d.doc_type='invoice' AND d.status='sent' AND d.due_date IS NOT NULL AND d.due_date < ?" + " ORDER BY d.due_date").bind(userId, today).all<{ id: string; number: number; currency: DocCurrency; dueDate: string; contactName: string | null; totalMinor: number }>();
  return r.results ?? [];
}
