import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Serves a contact's stored avatar from the app's own origin, only to the owning approved user.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return new Response("Unauthorized", { status: 401 });
  const { env } = await getCloudflareContext({ async: true });
  const row = await env.DB.prepare("SELECT avatar_data AS data FROM contacts WHERE id=? AND user_id=?").bind(id, session.user.id).first<{ data: string | null }>();
  const m = row?.data ? /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(row.data) : null;
  if (!m) return new Response("Not found", { status: 404 });
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
}
