import type { D1Like } from "./finance.ts";

/** Approved-user cap from app_settings. Missing or unusable values fall back to 5. */
export async function getMaxUsers(db: D1Like): Promise<number> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'max_users'").bind().first<{ value?: unknown }>();
  const raw = row?.value;
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) return 5;
  return n;
}
