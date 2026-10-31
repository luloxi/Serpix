import { NextResponse } from "next/server";
import { redeemInvite } from "@/lib/invites";
import { sessionContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Any signed-in user (including pending). Does not require an approved session. */
export async function POST(request: Request) {
  const ctx = await sessionContext();
  if (!ctx) return unauthorized();
  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body?.code === "string") code = body.code;
  } catch { /* invalid JSON is an invalid code */ }
  const result = await redeemInvite(ctx.db, ctx.userId, code, Date.now());
  const status = result.status === "disabled" ? 423 : 200;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
