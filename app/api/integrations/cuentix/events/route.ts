import { getCloudflareContext } from "@opennextjs/cloudflare";
import { handleCuentixEvent, MAX_SYNC_BODY_BYTES } from "@/lib/cuentix-sync";

export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Cuentix pushes signed business movements. The route only checks size and delegates.
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_SYNC_BODY_BYTES) return json({ error: "too_large" }, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_SYNC_BODY_BYTES) return json({ error: "too_large" }, 413);
  const { env } = await getCloudflareContext({ async: true });
  const result = await handleCuentixEvent(env.DB, {
    secret: env.CUENTIX_SYNC_SECRET,
    ownerEmail: env.CUENTIX_SYNC_OWNER_EMAIL,
    rawBody,
    timestamp: request.headers.get("x-sync-timestamp"),
    nonce: request.headers.get("x-sync-nonce"),
    signature: request.headers.get("x-sync-signature"),
    now: Date.now(),
  });
  return json(result.body, result.status);
}
