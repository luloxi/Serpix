import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { todayBA } from "@/lib/agenda-dates";
import { convertQuote, deleteDocument, getDocument, isOverdue, parseDocInput, payDocument, setStatus, updateDocument } from "@/lib/documents";

export const dynamic = "force-dynamic";
async function context() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return null;
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB };
}
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const c = await context(); if (!c) return unauthorized();
  const { id } = await params;
  const doc = await getDocument(c.db, c.userId, id);
  if (!doc) return NextResponse.json({ error: "Comprobante inexistente" }, { status: 404 });
  return NextResponse.json({ ...doc, overdue: isOverdue(doc, todayBA()) }, { headers: { "Cache-Control": "no-store" } });
}

// Body: { action: "save" | "status" | "pay" | "convert", ... }
export async function PATCH(request: Request, { params }: Params) {
  const c = await context(); if (!c) return unauthorized();
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const now = Date.now(), today = todayBA();
  let r;
  if (b.action === "save") {
    const parsed = parseDocInput(b, today);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    r = await updateDocument(c.db, c.userId, id, parsed.value, now);
  } else if (b.action === "status") {
    if (b.status !== "draft" && b.status !== "sent" && b.status !== "void") return NextResponse.json({ error: "Estado inválido" }, { status: 400 });
    r = await setStatus(c.db, c.userId, id, b.status, now);
  } else if (b.action === "pay") {
    r = await payDocument(c.db, c.userId, id, typeof b.accountId === "string" ? b.accountId : "", typeof b.paidAt === "string" ? b.paidAt : today, now);
  } else if (b.action === "convert") {
    r = await convertQuote(c.db, c.userId, id, today, now);
  } else return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
  return NextResponse.json(r.body, { status: r.status });
}

export async function DELETE(_req: Request, { params }: Params) {
  const c = await context(); if (!c) return unauthorized();
  const { id } = await params;
  const r = await deleteDocument(c.db, c.userId, id);
  return NextResponse.json(r.body, { status: r.status });
}
