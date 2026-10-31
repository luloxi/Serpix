import { NextResponse } from "next/server";
import { approvedContext } from "@/lib/session";
import { MAX_RECEIPT_BYTES, RECEIPT_MODEL, readReceipt, type AiLike } from "@/lib/receipt";
import { isReceiptMime, overScanLimit, scansToday, sniffMime } from "@/lib/receipts-db";
import { todayInBuenosAires } from "@/lib/recurring";

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
  if (file.size > MAX_RECEIPT_BYTES) return json({ error: "El archivo pesa demasiado (máx. 1,5 MB). Probá con una foto o un PDF más liviano." }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !isReceiptMime(mime)) return json({ error: "Formato no admitido. Usá JPG, PNG, WebP o PDF." }, 415);
  const now = Date.now();
  if (overScanLimit(await scansToday(ctx.db, ctx.userId, now))) return json({ error: "Llegaste al límite de tickets por día. Cargá el gasto a mano." }, 429);

  const base64 = Buffer.from(bytes).toString("base64");
  const id = crypto.randomUUID();
  const ai = (ctx.env as unknown as { AI?: AiLike }).AI;
  const result = ai ? await readReceipt(ai, { mime, base64 }, todayInBuenosAires(now)) : ({ ok: false, reason: "sin_ia" } as const);
  if (!result.ok) console.warn("receipt_read_failed", { reason: result.reason });
  await ctx.db.prepare("INSERT INTO receipts (id,user_id,transaction_id,mime,size,data,extracted,read_ok,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, ctx.userId, null, mime, bytes.length, base64, result.ok ? JSON.stringify(result.fields) : null, result.ok ? 1 : 0, now).run();
  return json({ receiptId: id, mime, ok: result.ok, fields: result.ok ? result.fields : null, model: RECEIPT_MODEL }, 201);
}
