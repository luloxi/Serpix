import { NextResponse } from "next/server";
import { adminContext, approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await ctx.db.prepare(
    "SELECT id, name, email, approvalStatus, role, createdAt, ai_receipts_enabled AS aiReceipts, encryption_mode AS encryptionMode FROM user ORDER BY createdAt DESC"
  ).all<{ id: string; name: string; email: string; approvalStatus: string; role: string; createdAt: number; aiReceipts: number; encryptionMode: string }>();

  const users = (result.results ?? []).map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    approvalStatus: user.approvalStatus,
    role: user.role,
    createdAt: user.createdAt,
    aiReceipts: Number(user.aiReceipts) === 1,
    encryptionMode: user.encryptionMode === "e2e" ? "e2e" : "server",
  }));
  return NextResponse.json({ users });
}
