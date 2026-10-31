import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";
import { importableTimeEntries } from "@/lib/documents";

export const dynamic = "force-dynamic";

// Billable hours of a client's tasks that are not in any comprobante yet (in the given currency).
export async function GET(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  const q = new URL(request.url).searchParams;
  const contactId = q.get("contactId") ?? "", currency = q.get("currency") === "USD" ? "USD" : "ARS", docId = q.get("docId") || null;
  if (!contactId) return NextResponse.json({ items: [] });
  const items = await importableTimeEntries(ctx.db, ctx.userId, contactId, currency, docId);
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
