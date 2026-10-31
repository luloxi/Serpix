import { NextResponse } from "next/server";
import { adminContext, approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as { approvalStatus?: string };
  if (body.approvalStatus !== "approved" && body.approvalStatus !== "rejected") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { userId } = await params;
  if (userId === ctx.userId) {
    return NextResponse.json({ error: "Cannot change own access" }, { status: 400 });
  }

  const result = await ctx.db.prepare(
    "UPDATE user SET approvalStatus = ?, updatedAt = ? WHERE id = ? AND role != 'admin'"
  ).bind(body.approvalStatus, Date.now(), userId).run();

  if (result.meta.changes === 0) {
    return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
  }

  if (body.approvalStatus === "rejected") {
    await ctx.db.prepare("DELETE FROM session WHERE userId = ?").bind(userId).run();
  }

  return NextResponse.json({ ok: true });
}
