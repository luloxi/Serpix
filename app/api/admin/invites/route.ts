import { NextResponse } from "next/server";
import { generateInvite, listInvites } from "@/lib/invites";
import { adminContext, approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const invites = await listInvites(ctx.db, Date.now());
  return NextResponse.json({ invites }, { headers: noStore });
}

export async function POST(request: Request) {
  if (!(await approvedContext())) return unauthorized();
  const ctx = await adminContext();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let note: string | undefined;
  try {
    const body = (await request.json()) as { note?: unknown };
    if (typeof body?.note === "string") note = body.note;
  } catch { /* a body is optional */ }
  const now = Date.now();
  const created = await generateInvite(ctx.db, ctx.userId, now, note);
  const url = new URL(request.url).origin + "/invite/" + created.code;
  return NextResponse.json({ url, expiresAt: created.expiresAt, id: created.id }, { status: 201, headers: noStore });
}
