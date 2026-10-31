// Recurring movements: pure date math plus the generator (no Next.js or Cloudflare imports, so node:test can load it).
import type { D1Like } from "./finance.ts";
import { reconcileManual } from "./cuentix-sync.ts";

export const FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const RULE_STATUSES = ["active", "paused", "ended"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PER_RUN = 400;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function key(y: number, m: number, d: number): string {
  return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

export function addDays(dateKey: string, days: number): string {
  const m = DATE_RE.exec(dateKey)!;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The k-th occurrence (k = 0 is the anchor). Monthly and yearly keep the anchor's day, clamped to the month length. */
export function occurrenceDate(anchor: string, frequency: Frequency, k: number): string {
  const m = DATE_RE.exec(anchor)!;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (frequency === "weekly") return addDays(anchor, 7 * k);
  if (frequency === "monthly") {
    const index = mo - 1 + k;
    const year = y + Math.floor(index / 12);
    const month = ((index % 12) + 12) % 12 + 1;
    return key(year, month, Math.min(d, daysInMonth(year, month)));
  }
  const year = y + k;
  return key(year, mo, Math.min(d, daysInMonth(year, mo)));
}

export type RuleSchedule = {
  anchorDate: string;
  frequency: Frequency;
  endDate: string | null;
  fromDate: string;
  generatedThrough: string | null;
};

/** Occurrence dates still to generate: after generatedThrough, not before fromDate, up to today and the end date. */
export function dueDates(rule: RuleSchedule, today: string, cap = MAX_PER_RUN): string[] {
  const limit = rule.endDate && rule.endDate < today ? rule.endDate : today;
  const out: string[] = [];
  for (let k = 0; k < 20000 && out.length < cap; k++) {
    const date = occurrenceDate(rule.anchorDate, rule.frequency, k);
    if (date > limit) break;
    if (date < rule.fromDate) continue;
    if (rule.generatedThrough && date <= rule.generatedThrough) continue;
    out.push(date);
  }
  return out;
}

/** First occurrence strictly after `today` (or on it when `inclusive`), honoring the end date. Null when the rule is over. */
export function nextDate(rule: Pick<RuleSchedule, "anchorDate" | "frequency" | "endDate">, today: string, inclusive = false): string | null {
  for (let k = 0; k < 20000; k++) {
    const date = occurrenceDate(rule.anchorDate, rule.frequency, k);
    if (rule.endDate && date > rule.endDate) return null;
    if (inclusive ? date >= today : date > today) return date;
  }
  return null;
}

/** Today's date in Buenos Aires (UTC-3, no DST). */
export function todayInBuenosAires(now = Date.now()): string {
  return new Date(now - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export type RecurrenceInput = { frequency: Frequency; endDate: string | null };

/** Validates the `recurrence` fields sent with a movement. Returns null for "no recurrence", an error string when invalid. */
export function parseRecurrence(frequency: unknown, endDate: unknown, anchor: string): RecurrenceInput | null | string {
  if (frequency === undefined || frequency === null || frequency === "" || frequency === "none") return null;
  if (!FREQUENCIES.includes(frequency as Frequency)) return "Frecuencia inválida";
  const end = typeof endDate === "string" && endDate.trim() ? endDate.trim() : null;
  if (end !== null) {
    if (!isDateKey(end)) return "Fecha de fin inválida";
    if (end < anchor) return "La fecha de fin es anterior al primer movimiento";
  }
  return { frequency: frequency as Frequency, endDate: end };
}

export type RuleRow = {
  id: string;
  user_id: string;
  account_id: string;
  contact_id: string | null;
  kind: string;
  amount_minor: number;
  category: string;
  description: string | null;
  frequency: Frequency;
  anchor_date: string;
  end_date: string | null;
  from_date: string;
  generated_through: string | null;
};

/**
 * Creates the movements that are due. Idempotent: the unique index on (recurring_id, recurring_period)
 * plus INSERT OR IGNORE means running it twice, or two runs at once, never duplicates a period.
 * Pass userId to limit it to one user (lazy catch-up when the app loads); null for the daily cron.
 */
export async function generateDue(db: D1Like, userId: string | null, today: string, now = Date.now()): Promise<{ rules: number; created: number }> {
  const sql = "SELECT id,user_id,account_id,contact_id,kind,amount_minor,category,description,frequency,anchor_date,end_date,from_date,generated_through FROM recurring_rules WHERE status='active'"
    + (userId ? " AND user_id=?" : "") + " AND (generated_through IS NULL OR generated_through < ?) LIMIT 500";
  const stmt = userId ? db.prepare(sql).bind(userId, today) : db.prepare(sql).bind(today);
  const rows = (await stmt.all<RuleRow>()).results ?? [];
  let created = 0;
  for (const rule of rows) {
    const dates = dueDates({ anchorDate: rule.anchor_date, frequency: rule.frequency, endDate: rule.end_date, fromDate: rule.from_date, generatedThrough: rule.generated_through }, today);
    for (const date of dates) {
      const id = crypto.randomUUID();
      const result = await db.prepare("INSERT OR IGNORE INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at,recurring_id,recurring_period) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, rule.user_id, rule.account_id, rule.contact_id, rule.kind, rule.amount_minor, rule.category, rule.description, date, now, rule.id, date).run();
      created += result.meta.changes;
      if (result.meta.changes) await reconcileManual(db, rule.user_id, id, now);
    }
    const limit = rule.end_date && rule.end_date < today ? rule.end_date : today;
    // If the per-run cap cut the list short, advance only to the last date handled so the next run continues.
    const through = dates.length >= MAX_PER_RUN ? dates[dates.length - 1] : limit;
    const over = !!rule.end_date && rule.end_date < today && dates.length < MAX_PER_RUN;
    await db.prepare("UPDATE recurring_rules SET generated_through=?, status=?, updated_at=? WHERE id=? AND user_id=?")
      .bind(through, over ? "ended" : "active", now, rule.id, rule.user_id).run();
  }
  return { rules: rows.length, created };
}

export const RULES_SQL = "SELECT r.id, r.kind, r.amount_minor AS amountMinor, r.category, r.description, r.frequency, r.anchor_date AS anchorDate, r.end_date AS endDate, r.status, r.account_id AS accountId, a.name AS accountName, a.currency AS currency, r.contact_id AS contactId FROM recurring_rules r JOIN financial_accounts a ON a.id = r.account_id AND a.user_id = r.user_id WHERE r.user_id = ? ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, r.category COLLATE NOCASE";

export const FREQUENCY_LABEL: Record<Frequency, string> = { weekly: "Semanal", monthly: "Mensual", yearly: "Anual" };

export type NewRule = {
  accountId: string;
  contactId: string | null;
  kind: "income" | "expense";
  amountMinor: number;
  category: string;
  description: string | null;
  anchorDate: string;
  recurrence: RecurrenceInput;
};

/**
 * Creates a rule whose first movement (the anchor) is `transactionId`, already saved by the caller:
 * the movement is linked to the rule and the rule starts counting after it. Returns the rule id.
 */
export async function createRuleForTransaction(db: D1Like, userId: string, transactionId: string, rule: NewRule, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO recurring_rules (id,user_id,account_id,contact_id,kind,amount_minor,category,description,frequency,anchor_date,end_date,status,from_date,generated_through,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, userId, rule.accountId, rule.contactId, rule.kind, rule.amountMinor, rule.category, rule.description, rule.recurrence.frequency, rule.anchorDate, rule.recurrence.endDate, "active", rule.anchorDate, rule.anchorDate, now, now).run();
  await db.prepare("UPDATE financial_transactions SET recurring_id=?, recurring_period=? WHERE id=? AND user_id=? AND recurring_id IS NULL").bind(id, rule.anchorDate, transactionId, userId).run();
  return id;
}
