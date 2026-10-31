import { NextResponse } from "next/server";
import { E2E_NOT_ENABLED, encryptionMode, httpError, listRecords, parseListQuery } from "@/lib/e2e-server";
import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function unauth() {
  const response = unauthorized();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  if ((await encryptionMode(ctx.db, ctx.userId)) !== "e2e") return json({ error: E2E_NOT_ENABLED }, 403);
  const url = new URL(request.url);
  const parsed = parseListQuery(url.searchParams.get("collection"), url.searchParams.get("since"), url.searchParams.get("limit"));
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  return json(await listRecords(ctx.db, ctx.userId, parsed));
}
