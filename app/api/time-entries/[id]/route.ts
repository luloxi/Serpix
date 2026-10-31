import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return json({ error: "Unauthorized" }, 401);
  if (!id || id.length > 80) return json({ error: "No encontrado" }, 404);
  const { env } = await getCloudflareContext({ async: true });
  const userId = session.user.id;
  const existing = await env.DB.prepare("SELECT id FROM time_entries WHERE id=? AND user_id=?").bind(id, userId).first();
  if (!existing) return json({ error: "No encontrado" }, 404);
  await env.DB.prepare("DELETE FROM time_entries WHERE id=? AND user_id=?").bind(id, userId).run();
  return json({ ok: true });
}
