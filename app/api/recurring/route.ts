import { NextResponse } from "next/server";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext } from "@/lib/session";
import { RULES_SQL, generateDue, nextDate, todayInBuenosAires, type Frequency } from "@/lib/recurring";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** Lists the user's rules. Also catches up anything due (the daily cron does the same for everyone), so the list is always current. */
export async function GET() {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  const today = todayInBuenosAires();
  let created = 0;
  try { created = (await generateDue(ctx.db, ctx.userId, today)).created; } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    console.error("recurring_catchup_failed", { error: String(error) });
  }
  const rows = (await ctx.db.prepare(RULES_SQL).bind(ctx.userId).all<Record<string, unknown>>()).results ?? [];
  const items = rows.map((r: Record<string, unknown>) => ({
    ...r,
    nextDate: r.status === "active" ? nextDate({ anchorDate: String(r.anchorDate), frequency: r.frequency as Frequency, endDate: (r.endDate as string | null) ?? null }, today, true) : null,
  }));
  return json({ items, created });
}
