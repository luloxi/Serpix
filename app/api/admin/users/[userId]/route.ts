import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as { approvalStatus?: string };
  if (body.approvalStatus !== "approved" && body.approvalStatus !== "rejected") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { userId } = await params;
  if (userId === session.user.id) {
    return NextResponse.json({ error: "Cannot change own access" }, { status: 400 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const result = await env.DB.prepare(
    "UPDATE user SET approvalStatus = ?, updatedAt = ? WHERE id = ? AND role != 'admin'"
  ).bind(body.approvalStatus, Date.now(), userId).run();

  if (result.meta.changes === 0) {
    return NextResponse.json({ error: "User not found or protected" }, { status: 404 });
  }

  if (body.approvalStatus === "rejected") {
    await env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(userId).run();
  }

  return NextResponse.json({ ok: true });
}
