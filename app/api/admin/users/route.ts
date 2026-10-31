import { NextResponse } from "next/server";
import { adminContext, approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await ctx.db.prepare(
    "SELECT id, name, email, approvalStatus, createdAt FROM user ORDER BY createdAt DESC"
  ).all();

  return NextResponse.json({ users: result.results });
}
