import { NextResponse } from "next/server";
import { AI_DISABLED_MESSAGE, AI_GLOBAL_LIMIT_MESSAGE, INVITEE_RECEIPT_SCANS_PER_DAY, SCAN_LIMIT_MESSAGE, refundNeurons, refundReceiptScan, reserveNeurons, reserveReceiptScan } from "@/lib/ai-quota";
import { E2E_NOT_ENABLED, SCAN_AI_WARNING, encryptionMode } from "@/lib/e2e-server";
import { MAX_RECEIPT_BASE64_CHARS, MAX_RECEIPT_BYTES, RECEIPT_TOO_BIG_MESSAGE, readReceipt, type AiLike } from "@/lib/receipt";
import { isReceiptMime, sniffMime } from "@/lib/receipts-db";
import { todayInBuenosAires } from "@/lib/recurring";
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

/** Reads a ticket with Workers AI and stores nothing. The image leaves the device in the clear; the response says so. */
export async function POST(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return unauth();
  if ((await encryptionMode(ctx.db, ctx.userId)) !== "e2e") return json({ error: E2E_NOT_ENABLED }, 403);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "Archivo inválido" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Falta el archivo" }, 400);
  if (file.size > MAX_RECEIPT_BYTES) return json({ error: RECEIPT_TOO_BIG_MESSAGE }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !isReceiptMime(mime)) return json({ error: "Formato no admitido. Usá JPG, PNG, WebP o PDF." }, 415);
  const base64 = Buffer.from(bytes).toString("base64");
  if (base64.length > MAX_RECEIPT_BASE64_CHARS) return json({ error: RECEIPT_TOO_BIG_MESSAGE }, 413);

  const now = Date.now();
  const flag = await ctx.db.prepare("SELECT ai_receipts_enabled AS enabled FROM user WHERE id = ?").bind(ctx.userId).first<{ enabled: number }>();
  // Admins stay in server mode and keep using /api/receipts/scan, so this route is the invitee cap only.
  const allowed = Number(flag?.enabled) === 1;
  if (!allowed) return json({ ok: false, fields: null, aiStatus: "disabled", message: AI_DISABLED_MESSAGE, warning: SCAN_AI_WARNING });

  const limit = INVITEE_RECEIPT_SCANS_PER_DAY;
  if (!(await reserveReceiptScan(ctx.db, ctx.userId, now, limit))) return json({ error: SCAN_LIMIT_MESSAGE }, 429);
  if (!(await reserveNeurons(ctx.db, now))) {
    await refundReceiptScan(ctx.db, ctx.userId, now);
    return json({ ok: false, fields: null, aiStatus: "global_limit", message: AI_GLOBAL_LIMIT_MESSAGE, warning: SCAN_AI_WARNING });
  }
  const ai = (ctx.env as unknown as { AI?: AiLike }).AI;
  if (!ai) {
    await refundReceiptScan(ctx.db, ctx.userId, now);
    await refundNeurons(ctx.db, now);
    return json({ ok: false, fields: null, warning: SCAN_AI_WARNING });
  }
  const result = await readReceipt(ai, { mime, base64 }, todayInBuenosAires(now));
  if (!result.ok && result.reason !== "disabled" && result.reason !== "global_limit") console.warn("e2e_receipt_read_failed", { reason: result.reason });
  return json({ ok: result.ok, fields: result.ok ? result.fields : null, warning: SCAN_AI_WARNING });
}
