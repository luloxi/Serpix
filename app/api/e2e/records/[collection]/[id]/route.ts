import { NextResponse } from "next/server";
import { E2E_NOT_ENABLED, encryptionMode, httpError, parseRecordDelete, parseRecordWrite, tombstoneRecord, upsertRecord, validCollection, validRecordId } from "@/lib/e2e-server";
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

type Session = NonNullable<Awaited<ReturnType<typeof approvedContext>>>;

async function gate(): Promise<{ ctx: Session } | { ctx: null; denied: Response }> {
  const ctx = await approvedContext();
  if (!ctx) return { ctx: null, denied: unauth() };
  if ((await encryptionMode(ctx.db, ctx.userId)) !== "e2e") return { ctx: null, denied: json({ error: E2E_NOT_ENABLED }, 403) };
  return { ctx };
}

export async function PUT(request: Request, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const gated = await gate();
  if (!gated.ctx) return gated.denied;
  const ctx = gated.ctx;
  const { collection, id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  if (!validCollection(collection)) return json({ error: "Colección inválida" }, 400);
  if (!validRecordId(id)) return json({ error: "Identificador inválido" }, 400);
  const parsed = parseRecordWrite(collection, id, body);
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  try {
    const result = await upsertRecord(ctx.db, ctx.userId, collection, id, parsed, Date.now());
    if (!result.ok) {
      const error = httpError(result);
      return json(error.body, error.status);
    }
    return json({ ok: true, version: result.version, seq: result.seq }, result.created ? 201 : 200);
  } catch (error) {
    console.error("e2e_record_failed", String(error).slice(0, 180));
    return json({ error: "No se pudo guardar el registro" }, 500);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const gated = await gate();
  if (!gated.ctx) return gated.denied;
  const ctx = gated.ctx;
  const { collection, id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  if (!validCollection(collection)) return json({ error: "Colección inválida" }, 400);
  if (!validRecordId(id)) return json({ error: "Identificador inválido" }, 400);
  const parsed = parseRecordDelete(body);
  if (!parsed.ok) {
    const error = httpError(parsed);
    return json(error.body, error.status);
  }
  try {
    const result = await tombstoneRecord(ctx.db, ctx.userId, collection, id, parsed.expectedVersion, Date.now());
    if (!result.ok) {
      const error = httpError(result);
      return json(error.body, error.status);
    }
    return json({ ok: true, version: result.version, seq: result.seq });
  } catch (error) {
    console.error("e2e_record_failed", String(error).slice(0, 180));
    return json({ error: "No se pudo guardar el registro" }, 500);
  }
}
