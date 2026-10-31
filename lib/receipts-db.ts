// Receipt storage helpers shared by the API routes (pure D1 logic; testable with node:sqlite).
import type { D1Like } from "./finance.ts";
import { MAX_SCANS_PER_DAY, RECEIPT_MIMES } from "./receipt.ts";

export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length > 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

export function isReceiptMime(value: string): boolean {
  return (RECEIPT_MIMES as readonly string[]).includes(value);
}

/** Scans in the last 24 hours (every scan stores a row, read or not). */
export async function scansToday(db: D1Like, userId: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE user_id=? AND created_at>?").bind(userId, now - 86400000).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
export const overScanLimit = (n: number) => n >= MAX_SCANS_PER_DAY;

/** True when this user can attach the receipt (theirs, and free or already on this movement). */
export async function receiptLinkable(db: D1Like, userId: string, receiptId: string, transactionId: string | null): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM receipts WHERE id=? AND user_id=? AND (transaction_id IS NULL OR transaction_id=?)").bind(receiptId, userId, transactionId).first();
  return Boolean(row);
}

/** Links an uploaded receipt to a movement. Only the owner's unlinked (or already linked to this movement) receipt qualifies, and only onto the owner's movement. */
export async function attachReceipt(db: D1Like, userId: string, transactionId: string, receiptId: string): Promise<boolean> {
  const tx = await db.prepare("SELECT id FROM financial_transactions WHERE id=? AND user_id=?").bind(transactionId, userId).first();
  if (!tx) return false;
  await db.prepare("DELETE FROM receipts WHERE transaction_id=? AND user_id=? AND id<>?").bind(transactionId, userId, receiptId).run();
  const result = await db.prepare("UPDATE receipts SET transaction_id=? WHERE id=? AND user_id=? AND (transaction_id IS NULL OR transaction_id=?)").bind(transactionId, receiptId, userId, transactionId).run();
  return result.meta.changes > 0;
}

/** Cron cleanup: scans that were never attached to a movement. */
export async function purgeOrphanReceipts(db: D1Like, now: number): Promise<number> {
  const result = await db.prepare("DELETE FROM receipts WHERE transaction_id IS NULL AND created_at<?").bind(now - 2 * 86400000).run();
  return result.meta.changes;
}
