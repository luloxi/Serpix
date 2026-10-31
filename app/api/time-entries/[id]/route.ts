import { NextResponse } from "next/server";
import { approvedContext } from "@/lib/session";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if (!id || id.length > 80) return json({ error: "No encontrado" }, 404);
  const existing = await ctx.db.prepare("SELECT id FROM time_entries WHERE id=? AND user_id=?").bind(id, ctx.userId).first();
  if (!existing) return json({ error: "No encontrado" }, 404);
  await ctx.db.prepare("DELETE FROM time_entries WHERE id=? AND user_id=?").bind(id, ctx.userId).run();
  return json({ ok: true });
}
