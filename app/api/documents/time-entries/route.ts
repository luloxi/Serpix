import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { importableTimeEntries } from "@/lib/documents";

export const dynamic = "force-dynamic";

// Billable hours of a client's tasks that are not in any comprobante yet (in the given currency).
export async function GET(request: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { env } = await getCloudflareContext({ async: true });
  const q = new URL(request.url).searchParams;
  const contactId = q.get("contactId") ?? "", currency = q.get("currency") === "USD" ? "USD" : "ARS", docId = q.get("docId") || null;
  if (!contactId) return NextResponse.json({ items: [] });
  const items = await importableTimeEntries(env.DB, session.user.id, contactId, currency, docId);
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
