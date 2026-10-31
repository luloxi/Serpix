import type { D1Like } from "./finance.ts";
import { todayInBuenosAires } from "./recurring.ts";

/** Free Workers AI allocation for the whole Cloudflare account. Resets 00:00 UTC. */
export const AI_FREE_NEURONS_PER_DAY = 10_000;
/** Stop at 70% so other projects on the same account keep a 30% margin. */
export const AI_CUTOFF_NEURONS = 7_000;
/** Conservative round-up for one llama-3.2-11b-vision receipt (~1.6k input + ~300 output tokens). */
export const NEURONS_PER_SCAN_ESTIMATE = 40;
export const ADMIN_RECEIPT_SCANS_PER_DAY = 60;
export const INVITEE_RECEIPT_SCANS_PER_DAY = 10;

export const AI_DISABLED_MESSAGE = "La lectura automática no está activada para tu cuenta. Cargá el gasto a mano; podés pedirle al administrador que la active.";
export const AI_GLOBAL_LIMIT_MESSAGE = "La lectura automática se pausó por hoy (cupo gratuito diario). Cargá el gasto a mano; mañana vuelve.";
export const SCAN_LIMIT_MESSAGE = "Llegaste al límite de tickets por día. Cargá el gasto a mano.";

const RESERVE_SQL = "INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, ?, ?, ?) ON CONFLICT(day, scope, kind) DO UPDATE SET amount = amount + excluded.amount WHERE amount + excluded.amount <= ?";
const REFUND_SQL = "UPDATE usage_daily SET amount = amount - ? WHERE day = ? AND scope = ? AND kind = ? AND amount >= ?";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function changed(result: { meta?: { changes?: number } }): boolean {
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Inserts or increments only when the new total stays within `limit`. */
export async function reserveUsage(db: D1Like, day: string, scope: string, kind: string, amount: number, limit: number): Promise<boolean> {
  const result = await db.prepare(RESERVE_SQL).bind(day, scope, kind, amount, limit).run();
  return changed(result);
}

export async function refundUsage(db: D1Like, day: string, scope: string, kind: string, amount: number): Promise<boolean> {
  const result = await db.prepare(REFUND_SQL).bind(amount, day, scope, kind, amount).run();
  return changed(result);
}

export async function reserveNeurons(db: D1Like, now: number, amount = NEURONS_PER_SCAN_ESTIMATE): Promise<boolean> {
  return reserveUsage(db, utcDay(now), "global", "ai_neurons", amount, AI_CUTOFF_NEURONS);
}

export async function refundNeurons(db: D1Like, now: number, amount = NEURONS_PER_SCAN_ESTIMATE): Promise<boolean> {
  return refundUsage(db, utcDay(now), "global", "ai_neurons", amount);
}

export async function reserveReceiptScan(db: D1Like, userId: string, now: number, limit: number): Promise<boolean> {
  return reserveUsage(db, todayInBuenosAires(now), userId, "receipt_scans", 1, limit);
}

export async function refundReceiptScan(db: D1Like, userId: string, now: number): Promise<boolean> {
  return refundUsage(db, todayInBuenosAires(now), userId, "receipt_scans", 1);
}
