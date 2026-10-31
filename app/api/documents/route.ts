import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { todayBA } from "@/lib/agenda-dates";
import { createDocument, isOverdue, listDocuments, parseDocInput, type DocType } from "@/lib/documents";

export const dynamic = "force-dynamic";
async function context() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return null;
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB, issuerName: session.user.name, issuerEmail: session.user.email };
}
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET() {
  const c = await context(); if (!c) return unauthorized();
  const today = todayBA();
  const rows = (await listDocuments(c.db, c.userId)) as { type: DocType; status: string; dueDate: string | null }[];
  const items = rows.map((r) => ({ ...r, overdue: isOverdue(r, today) }));
  return NextResponse.json({ items, today, issuer: { name: c.issuerName, email: c.issuerEmail } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const c = await context(); if (!c) return unauthorized();
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const parsed = parseDocInput(body, todayBA());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await createDocument(c.db, c.userId, parsed.value, Date.now());
  return NextResponse.json(r.body, { status: r.status });
}
