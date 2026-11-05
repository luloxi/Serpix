import { NextResponse } from "next/server";
import { isNoteMediaId } from "@/lib/note-media";
import { encryptedAccount, legacyDataContext } from "@/lib/session";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** Serves a note image to its owner only. Private, never cached, never sniffed. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  if (!isNoteMediaId(id)) return json({ error: "No encontrado" }, 404);
  const row = await ctx.db.prepare("SELECT mime, data FROM note_media WHERE id=? AND user_id=?").bind(id, ctx.userId).first<{ mime: string; data: string }>();
  if (!row) return json({ error: "No encontrado" }, 404);
  const binary = atob(row.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  if (!isNoteMediaId(id)) return json({ error: "No encontrado" }, 404);
  const result = await ctx.db.prepare("DELETE FROM note_media WHERE id=? AND user_id=?").bind(id, ctx.userId).run();
  if (result.meta.changes === 0) return json({ error: "No encontrado" }, 404);
  return json({ ok: true });
}
