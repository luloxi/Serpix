import { NextResponse } from "next/server";
import { getMaxUsers } from "@/lib/settings";
import { adminContext, approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as { approvalStatus?: string; aiReceipts?: boolean };
  const { userId } = await params;

  if (typeof body.aiReceipts === "boolean" && body.approvalStatus === undefined) {
    const result = await ctx.db.prepare(
      "UPDATE user SET ai_receipts_enabled = ?, updatedAt = ? WHERE id = ? AND role != 'admin'"
    ).bind(body.aiReceipts ? 1 : 0, Date.now(), userId).run();
    if (result.meta.changes === 0) {
      return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.approvalStatus !== "approved" && body.approvalStatus !== "rejected") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (userId === ctx.userId) {
    return NextResponse.json({ error: "Cannot change own access" }, { status: 400 });
  }

  if (body.approvalStatus === "rejected") {
    const result = await ctx.db.prepare(
      "UPDATE user SET approvalStatus = ?, updatedAt = ? WHERE id = ? AND role != 'admin'"
    ).bind(body.approvalStatus, Date.now(), userId).run();

    if (result.meta.changes === 0) {
      return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
    }

    await ctx.db.prepare("DELETE FROM session WHERE userId = ?").bind(userId).run();
    return NextResponse.json({ ok: true });
  }

  const target = await ctx.db.prepare("SELECT role, approvalStatus FROM user WHERE id = ?").bind(userId).first<{ role: string; approvalStatus: string }>();
  if (!target || target.role === "admin") {
    return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
  }
  if (target.approvalStatus === "approved") return NextResponse.json({ ok: true });

  const max = await getMaxUsers(ctx.db);
  const result = await ctx.db.prepare(
    "UPDATE user SET approvalStatus = 'approved', updatedAt = ? WHERE id = ? AND role != 'admin' AND approvalStatus != 'approved' AND (SELECT COUNT(*) FROM user WHERE approvalStatus = 'approved') < ?"
  ).bind(Date.now(), userId, max).run();
  if (result.meta.changes === 0) {
    const again = await ctx.db.prepare("SELECT role, approvalStatus FROM user WHERE id = ?").bind(userId).first<{ role: string; approvalStatus: string }>();
    if (!again || again.role === "admin") return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
    if (again.approvalStatus === "approved") return NextResponse.json({ ok: true });
    return NextResponse.json({ error: `Alcanzaste el tope de ${max} usuarios.` }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
