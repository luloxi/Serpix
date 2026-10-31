/** Raised by the plaintext-write triggers (migrations 0016 and 0017). */
export const E2E_PLAINTEXT_WRITE = "e2e_account_plaintext_write";

/** SQLite extended result SQLITE_CONSTRAINT_TRIGGER. */
export const SQLITE_CONSTRAINT_TRIGGER = 1811;

/**
 * True when a D1, miniflare, or node:sqlite error is the plaintext-write abort.
 * Looks at the message, the trigger code, and nested `cause` values.
 * A UNIQUE or other constraint is not a match.
 */
export function isE2ePlaintextWrite(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (value == null || depth > 8) return false;
    if (typeof value === "string") return value.includes(E2E_PLAINTEXT_WRITE);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const record = value as { message?: unknown; cause?: unknown; code?: unknown; errcode?: unknown };
    const code = record.code ?? record.errcode;
    if (code === SQLITE_CONSTRAINT_TRIGGER || code === "SQLITE_CONSTRAINT_TRIGGER") return true;
    if (typeof record.message === "string" && record.message.includes(E2E_PLAINTEXT_WRITE)) return true;
    return "cause" in record && visit(record.cause, depth + 1);
  };
  return visit(error, 0);
}
