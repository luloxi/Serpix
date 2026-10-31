import { NextResponse } from "next/server";
import { encryptedAccount, legacyDataContext, unauthorized } from "@/lib/session";
import { getFinanceTotals } from "@/lib/finance";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await legacyDataContext();
  if (!ctx) return unauthorized();
  if ("encrypted" in ctx) return encryptedAccount();
  return NextResponse.json(await getFinanceTotals(ctx.db, ctx.userId));
}
