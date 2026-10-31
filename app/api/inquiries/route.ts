import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  const r = await ctx.db.prepare("SELECT id, name, email, message, budget_json AS budgetJson, ref_code AS refCode, status, contact_id AS contactId, created_at AS createdAt FROM inquiries WHERE user_id=? ORDER BY created_at DESC LIMIT 300").bind(ctx.userId).all();
  return NextResponse.json({ items: r.results }, { headers: { "Cache-Control": "no-store" } });
}
