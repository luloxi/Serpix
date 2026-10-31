import { NextResponse } from "next/server";
import { ADMIN_RECEIPT_SCANS_PER_DAY, AI_DISABLED_MESSAGE, AI_GLOBAL_LIMIT_MESSAGE, INVITEE_RECEIPT_SCANS_PER_DAY, SCAN_LIMIT_MESSAGE, refundNeurons, refundReceiptScan, reserveNeurons, reserveReceiptScan } from "@/lib/ai-quota";
import { isReceiptTooBigError, MAX_RECEIPT_BASE64_CHARS, MAX_RECEIPT_BYTES, RECEIPT_MODEL, RECEIPT_TOO_BIG_MESSAGE, readReceipt, type AiLike, type ReadResult } from "@/lib/receipt";
import { isReceiptMime, sniffMime } from "@/lib/receipts-db";
import { todayInBuenosAires } from "@/lib/recurring";
import { approvedContext } from "@/lib/session";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** Stores the ticket (D1, owner-only) and tries to read it with Workers AI. A failed read still keeps the file so the form can be filled by hand. */
export async function POST(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
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
  const id = crypto.randomUUID();
  const flag = await ctx.db.prepare("SELECT ai_receipts_enabled AS enabled FROM user WHERE id = ?").bind(ctx.userId).first<{ enabled: number }>();
  const allowed = ctx.role === "admin" || Number(flag?.enabled) === 1;

  const store = async (result: ReadResult, extra?: Record<string, unknown>) => {
    if (!result.ok && result.reason !== "disabled" && result.reason !== "global_limit") console.warn("receipt_read_failed", { reason: result.reason });
    try {
      await ctx.db.prepare("INSERT INTO receipts (id,user_id,transaction_id,mime,size,data,extracted,read_ok,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(id, ctx.userId, null, mime, bytes.length, base64, result.ok ? JSON.stringify(result.fields) : null, result.ok ? 1 : 0, now).run();
    } catch (error) {
      if (isReceiptTooBigError(error)) return json({ error: RECEIPT_TOO_BIG_MESSAGE }, 413);
      console.error("receipt_insert_failed", String(error));
      return json({ error: "No se pudo guardar el ticket" }, 500);
    }
    return json({ receiptId: id, mime, ok: result.ok, fields: result.ok ? result.fields : null, model: RECEIPT_MODEL, ...extra }, 201);
  };

  // Flag off: keep the file for manual entry and do not spend either quota. Admins are always allowed.
  if (!allowed) return store({ ok: false, reason: "disabled" }, { aiStatus: "disabled", message: AI_DISABLED_MESSAGE });

  const limit = ctx.role === "admin" ? ADMIN_RECEIPT_SCANS_PER_DAY : INVITEE_RECEIPT_SCANS_PER_DAY;
  if (!(await reserveReceiptScan(ctx.db, ctx.userId, now, limit))) return json({ error: SCAN_LIMIT_MESSAGE }, 429);
  if (!(await reserveNeurons(ctx.db, now))) {
    await refundReceiptScan(ctx.db, ctx.userId, now);
    return store({ ok: false, reason: "global_limit" }, { aiStatus: "global_limit", message: AI_GLOBAL_LIMIT_MESSAGE });
  }

  const ai = (ctx.env as unknown as { AI?: AiLike }).AI;
  if (!ai) {
    await refundReceiptScan(ctx.db, ctx.userId, now);
    await refundNeurons(ctx.db, now);
    return store({ ok: false, reason: "sin_ia" });
  }
  const result = await readReceipt(ai, { mime, base64 }, todayInBuenosAires(now));
  return store(result);
}
