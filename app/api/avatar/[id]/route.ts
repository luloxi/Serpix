import { approvedContext, unauthorized } from "@/lib/session";
import { avatarChange } from "@/lib/avatar";

export const dynamic = "force-dynamic";

// Serves a contact's stored avatar from the app's own origin, only to the owning approved user.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await approvedContext();
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const row = await ctx.db.prepare("SELECT avatar_data AS data FROM contacts WHERE id=? AND user_id=?").bind(id, ctx.userId).first<{ data: string | null }>();
  const m = row?.data ? /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(row.data) : null;
  if (!m) return new Response("Not found", { status: 404 });
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
}

// Automatic lookup result from the browser. Never overrides a photo the user chose or uploaded.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const row = await ctx.db.prepare("SELECT avatar_data AS data, avatar_source AS source FROM contacts WHERE id=? AND user_id=?").bind(id, ctx.userId).first<{ data: string | null; source: string | null }>();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (row.data && !String(row.source || "").startsWith("auto:")) return Response.json({ error: "La foto ya fue elegida" }, { status: 409 });
  const av = avatarChange(body);
  if (av && /^auto:(x|telegram|github|linkedin|whatsapp|email)$/.test(av.source)) {
    await ctx.db.prepare("UPDATE contacts SET avatar_data=?, avatar_source=?, avatar_tried_at=NULL, avatar_tried_key=NULL, updated_at=? WHERE id=? AND user_id=?").bind(av.data, av.source, Date.now(), id, ctx.userId).run();
    return Response.json({ ok: true });
  }
  const key = typeof body.failedKey === "string" ? body.failedKey.slice(0, 600) : "";
  if (key) {
    await ctx.db.prepare("UPDATE contacts SET avatar_tried_at=?, avatar_tried_key=? WHERE id=? AND user_id=?").bind(Date.now(), key, id, ctx.userId).run();
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Nada para guardar" }, { status: 400 });
}
