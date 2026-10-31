import { NextResponse } from "next/server";
import { addWrap, httpError, listKeys, parseWrapCreate } from "@/lib/e2e-server";
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

export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  return json(await listKeys(ctx.db, ctx.userId));
}

export async function POST(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const parsed = parseWrapCreate(body);
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  const result = await addWrap(ctx.db, ctx.userId, parsed, Date.now());
  if (!result.ok) {
    const error = httpError(result);
    return json(error.body, error.status);
  }
  return json({ id: result.id, mode: "e2e" }, 201);
}
