// Receipt reading: prompt, reply parsing and the Workers AI call. Pure (no Next.js or Cloudflare imports) so node:test can load it.
import { isDateKey, addDays } from "./recurring.ts";

/** Workers AI vision model. Free tier: 10,000 neurons/day shared by the account; one ticket costs ~15-35 neurons. */
export const RECEIPT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const RECEIPT_CATEGORIES = ["Comida", "Supermercado", "Transporte", "Servicios", "Compras", "Salud", "Hogar", "Ocio", "Otros"] as const;
export const RECEIPT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAX_RECEIPT_BYTES = 1_400_000;
/** Base64 of a max-size file is ~1.87e6 chars; stay under D1's 2_000_000-byte row cap once the other columns are added. */
export const MAX_RECEIPT_BASE64_CHARS = 1_900_000;
export const RECEIPT_TOO_BIG_MESSAGE = "El archivo pesa demasiado (máx. 1,4 MB). Probá con una foto o un PDF más liviano.";
export const MAX_SCANS_PER_DAY = 60;

export function isReceiptTooBigError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("too big") || message.includes("too large") || message.includes("toobig");
}

export type ReceiptFields = {
  amountMinor: number | null;
  currency: "ARS" | "USD" | null;
  date: string | null;
  merchant: string | null;
  category: string | null;
};
export type ReadResult = { ok: true; fields: ReceiptFields } | { ok: false; reason: string };

export function parseAmountMinor(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,]/g, "");
    if (!/\d/.test(cleaned)) return null;
    const last = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
    const after = last === -1 ? 0 : cleaned.length - last - 1;
    // A final separator followed by 1-2 digits is the decimal point; followed by 3+ (or nothing) it is a thousands mark.
    if (last !== -1 && after >= 1 && after <= 2) n = Number(cleaned.slice(0, last).replace(/[.,]/g, "") + "." + cleaned.slice(last + 1));
    else n = Number(cleaned.replace(/[.,]/g, ""));
  } else return null;
  if (!Number.isFinite(n) || n <= 0 || n >= 1e11) return null;
  return Math.round(n * 100);
}

/** YYYY-MM-DD, or day/month/year (the Argentine order) with "/", "-" or "."; two-digit years mean 20xx. */
export function parseDateLoose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (isDateKey(v)) return v;
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:\D.*)?$/.exec(v);
  if (!m) return null;
  const year = m[3].length === 2 ? "20" + m[3] : m[3];
  const key = year + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  return isDateKey(key) ? key : null;
}

function currencyOf(value: unknown): "ARS" | "USD" | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase().replace(/[\s.]/g, "");
  if (["USD", "US$", "U$S", "USS", "DOLAR", "DOLARES", "DÓLAR", "DÓLARES", "DOLLAR", "DOLLARS"].includes(v)) return "USD";
  if (["ARS", "$", "AR$", "PESO", "PESOS", "$ARS"].includes(v)) return "ARS";
  return null;
}

/** Normalizes the model's JSON (object or text, possibly fenced) into validated fields. `today` is YYYY-MM-DD. */
export function parseReceiptReply(reply: unknown, today: string): ReadResult {
  let data: unknown = reply;
  if (typeof reply === "string") {
    const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
    if (start === -1 || end <= start) return { ok: false, reason: "sin_json" };
    try { data = JSON.parse(reply.slice(start, end + 1)); } catch { return { ok: false, reason: "json_invalido" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "sin_json" };
  const d = data as Record<string, unknown>;
  const amountMinor = parseAmountMinor(d.amount ?? d.total);
  const parsedDate = parseDateLoose(d.date);
  const date = parsedDate && parsedDate <= addDays(today, 1) ? parsedDate : null;
  const merchant = typeof d.merchant === "string" && d.merchant.trim() && d.merchant.trim().toLowerCase() !== "null" ? d.merchant.trim().slice(0, 80) : null;
  const cat = typeof d.category === "string" ? RECEIPT_CATEGORIES.find((c) => c.toLowerCase() === (d.category as string).trim().toLowerCase()) ?? null : null;
  const fields: ReceiptFields = { amountMinor, currency: currencyOf(d.currency), date, merchant, category: cat };
  if (fields.amountMinor === null && !fields.date && !fields.merchant) return { ok: false, reason: "sin_datos" };
  return { ok: true, fields };
}

export function receiptPrompt(today: string, kind: "image" | "text"): string {
  return "Sos un lector de tickets, facturas y comprobantes de compra de Argentina. "
    + (kind === "image" ? "Mirá la imagen" : "Leé el texto") + " y respondé SOLO un JSON con estas claves:\n"
    + '{"amount": "el total final pagado, copiado TAL COMO está impreso, entre comillas y con sus puntos y comas (ej. \\"16.760,50\\" o \\"$ 10.53\\"); no lo conviertas ni le saques separadores", "currency": "ARS" o "USD", "date": "YYYY-MM-DD" (en los tickets suele estar como día/mes/año), "merchant": nombre del comercio, "category": una de ' + JSON.stringify(RECEIPT_CATEGORIES) + "}\n"
    + "Si un dato no se lee con seguridad, poné null. No inventes. Hoy es " + today + ".";
}

export type AiLike = {
  run(model: string, input: unknown): Promise<unknown>;
  toMarkdown?(files: { name: string; blob: Blob }[]): Promise<{ data?: string }[]>;
};

function replyOf(result: unknown): unknown {
  return result && typeof result === "object" && "response" in result ? (result as { response: unknown }).response : result;
}

/** Reads a stored receipt. Never throws: any failure becomes { ok: false } so the form can be filled by hand. */
export async function readReceipt(ai: AiLike, file: { mime: string; base64: string }, today: string): Promise<ReadResult> {
  try {
    let content: unknown;
    if (file.mime === "application/pdf") {
      if (!ai.toMarkdown) return { ok: false, reason: "sin_pdf" };
      const bytes = Uint8Array.from(Buffer.from(file.base64, "base64"));
      const converted = await ai.toMarkdown([{ name: "ticket.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }]);
      const raw = String(converted?.[0]?.data ?? "");
      const text = (raw.includes("## Contents") ? raw.slice(raw.indexOf("## Contents") + 11) : raw).trim().slice(0, 6000);
      if (text.length < 15) return { ok: false, reason: "pdf_sin_texto" };
      content = [{ type: "text", text: receiptPrompt(today, "text") + "\n\nTexto:\n" + text }];
    } else {
      content = [
        { type: "text", text: receiptPrompt(today, "image") },
        { type: "image_url", image_url: { url: "data:" + file.mime + ";base64," + file.base64 } },
      ];
    }
    const result = await ai.run(RECEIPT_MODEL, {
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: "system", content: "You extract structured data from receipts. Output only JSON." }, { role: "user", content }],
    });
    return parseReceiptReply(replyOf(result), today);
  } catch (error) {
    return { ok: false, reason: "ia_error:" + String(error).slice(0, 120) };
  }
}
