import { NextResponse } from "next/server";
import { deleteWrap, httpError, parseTouch, parseWrapReplace, replacePasswordWrap, touchWrap, validRecordId } from "@/lib/e2e-server";
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

async function readBody(request: Request) {
  try { return { ok: true as const, body: await request.json() as unknown }; } catch { return { ok: false as const }; }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  const { id } = await params;
  if (!validRecordId(id)) return json({ error: "No encontrada" }, 404);
  const body = await readBody(request);
  if (!body.ok) return json({ error: "JSON inválido" }, 400);
  const parsed = parseWrapReplace(body.body);
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  const result = await replacePasswordWrap(ctx.db, ctx.userId, id, parsed.wrap);
  if (!result.ok) {
    const error = httpError(result);
    return json(error.body, error.status);
  }
  return json({ ok: true });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  const { id } = await params;
  if (!validRecordId(id)) return json({ error: "No encontrada" }, 404);
  const body = await readBody(request);
  if (!body.ok) return json({ error: "JSON inválido" }, 400);
  const parsed = parseTouch(body.body);
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  const result = await touchWrap(ctx.db, ctx.userId, id, Date.now());
  if (!result.ok) {
    const error = httpError(result);
    return json(error.body, error.status);
  }
  return json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  const { id } = await params;
  if (!validRecordId(id)) return json({ error: "No encontrada" }, 404);
  const result = await deleteWrap(ctx.db, ctx.userId, id);
  if (!result.ok) {
    const error = httpError(result);
    return json(error.body, error.status);
  }
  return json({ ok: true });
}
