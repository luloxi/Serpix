import { NextResponse } from "next/server";
import { encryptedAccount, legacyDataContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await legacyDataContext();
  if (!ctx) return unauthorized();
  if ("encrypted" in ctx) return encryptedAccount();
  const r = await ctx.db.prepare("SELECT id, name, email, message, budget_json AS budgetJson, ref_code AS refCode, status, contact_id AS contactId, created_at AS createdAt FROM inquiries WHERE user_id=? ORDER BY created_at DESC LIMIT 300").bind(ctx.userId).all();
  return NextResponse.json({ items: r.results }, { headers: { "Cache-Control": "no-store" } });
}
