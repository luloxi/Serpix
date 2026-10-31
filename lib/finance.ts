// Pure finance helpers (no Next.js or Cloudflare imports) so node:test can load them.

export const ACCOUNTS_SQL = "SELECT a.id, a.name, a.currency, a.opening_balance_minor AS openingBalanceMinor, a.opening_balance_minor + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount_minor ELSE -t.amount_minor END) FROM financial_transactions t WHERE t.account_id = a.id AND t.user_id = a.user_id), 0) AS balanceMinor FROM financial_accounts a WHERE a.user_id = ? ORDER BY a.name";

/** Unlimited aggregate. One row per currency + kind. No LIMIT. */
export const TOTALS_SQL = "SELECT a.currency AS currency, t.kind AS kind, COALESCE(SUM(t.amount_minor), 0) AS totalMinor, COUNT(*) AS count FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id WHERE t.user_id = ? GROUP BY a.currency, t.kind";

export type D1Bound = {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] | null }>;
  run(): Promise<{ meta: { changes: number } }>;
};

export type D1Like = {
  prepare(sql: string): { bind(...values: unknown[]): D1Bound };
};

export type CurrencyTotals = { incomeMinor: number; expenseMinor: number };
export type FinanceTotals = { ARS: CurrencyTotals; USD: CurrencyTotals; transactionCount: number };

const CURRENCIES = ["ARS", "USD"] as const;
type Currency = (typeof CURRENCIES)[number];

const str = (value: unknown, max = 5000) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const currencyOf = (value: unknown, fallback: Currency): Currency => (CURRENCIES.includes(value as Currency) ? (value as Currency) : fallback);
const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function getFinanceTotals(db: D1Like, userId: string): Promise<FinanceTotals> {
  const totals: FinanceTotals = { ARS: { incomeMinor: 0, expenseMinor: 0 }, USD: { incomeMinor: 0, expenseMinor: 0 }, transactionCount: 0 };
  const rows = await db.prepare(TOTALS_SQL).bind(userId).all<{ currency: string; kind: string; totalMinor: unknown; count: unknown }>();
  for (const row of rows.results ?? []) {
    totals.transactionCount += num(row.count);
    const bucket = row.currency === "USD" ? totals.USD : row.currency === "ARS" ? totals.ARS : null;
    if (!bucket) continue;
    if (row.kind === "income") bucket.incomeMinor = num(row.totalMinor);
    else if (row.kind === "expense") bucket.expenseMinor = num(row.totalMinor);
  }
  return totals;
}

export async function updateAccount(db: D1Like, userId: string, id: string, body: Record<string, unknown>, now: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const name = str(body.name, 100);
  if (!name) return { status: 400, body: { error: "El nombre es obligatorio" } };
  const existing = await db.prepare("SELECT currency FROM financial_accounts WHERE id=? AND user_id=?").bind(id, userId).first<{ currency: string }>();
  if (!existing) return { status: 404, body: { error: "Cuenta inexistente" } };
  const currency = currencyOf(body.currency, currencyOf(existing.currency, "ARS"));
  let result: { meta: { changes: number } };
  if (body.openingBalanceMinor !== undefined) {
    const opening = body.openingBalanceMinor;
    if (typeof opening !== "number" || !Number.isSafeInteger(opening)) return { status: 400, body: { error: "Saldo inicial inválido" } };
    result = await db.prepare("UPDATE financial_accounts SET name=?,currency=?,opening_balance_minor=?,updated_at=? WHERE id=? AND user_id=?").bind(name, currency, opening, now, id, userId).run();
  } else {
    result = await db.prepare("UPDATE financial_accounts SET name=?,currency=?,updated_at=? WHERE id=? AND user_id=?").bind(name, currency, now, id, userId).run();
  }
  if (result.meta.changes === 0) return { status: 404, body: { error: "Registro no encontrado" } };
  return { status: 200, body: { ok: true } };
}
