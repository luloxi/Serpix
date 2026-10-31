import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";
import { getFinanceTotals } from "@/lib/finance";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  return NextResponse.json(await getFinanceTotals(ctx.db, ctx.userId));
}
