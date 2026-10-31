import { NextResponse } from "next/server";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext, unauthorized } from "@/lib/session";
import { todayBA } from "@/lib/agenda-dates";
import { createDocument, isOverdue, listDocuments, parseDocInput, type DocType } from "@/lib/documents";

export const dynamic = "force-dynamic";

export async function GET() {
  const c = await legacyDataContext(); if (!c) return unauthorized(); if ("encrypted" in c) return encryptedAccount();
  const today = todayBA();
  const rows = (await listDocuments(c.db, c.userId)) as { type: DocType; status: string; dueDate: string | null }[];
  const items = rows.map((r) => ({ ...r, overdue: isOverdue(r, today) }));
  return NextResponse.json({ items, today, issuer: { name: c.name, email: c.email } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const c = await legacyDataContext(); if (!c) return unauthorized(); if ("encrypted" in c) return encryptedAccount();
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const parsed = parseDocInput(body, todayBA());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const r = await createDocument(c.db, c.userId, parsed.value, Date.now());
    return NextResponse.json(r.body, { status: r.status });
  } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    throw error;
  }
}
