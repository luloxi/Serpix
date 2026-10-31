import { NextResponse } from "next/server";
import { encryptedAccount, legacyDataContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Serves a ticket to its owner only. Private, never cached, never sniffed. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  const row = await ctx.db.prepare("SELECT mime, data FROM receipts WHERE id=? AND user_id=?").bind(id, ctx.userId).first<{ mime: string; data: string }>();
  if (!row) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": row.mime,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Referrer-Policy": "no-referrer",
  };
  if (row.mime !== "application/pdf") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  const binary = atob(row.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, { headers });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  const result = await ctx.db.prepare("DELETE FROM receipts WHERE id=? AND user_id=?").bind(id, ctx.userId).run();
  if (result.meta.changes === 0) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
