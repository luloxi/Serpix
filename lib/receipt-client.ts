// Browser helpers for tickets: shrink photos before upload (phone cameras give 3-8 MB images).
export const MAX_UPLOAD_BYTES = 1_400_000;

/** Re-encodes an image as JPEG (max 1400 px on the long side). Falls back to the original file when it cannot be decoded. */
export async function shrinkImage(file: File, maxSide = 1400): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.82, 0.68, 0.5]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    return file;
  } catch {
    return file;
  }
}

export type ScanResponse = {
  receiptId: string;
  ok: boolean;
  fields: { amountMinor: number | null; currency: "ARS" | "USD" | null; date: string | null; merchant: string | null; category: string | null } | null;
  aiStatus?: "disabled" | "global_limit";
  message?: string;
};

export const AI_READ_LABEL = "Leer el ticket con IA";
export const AI_READ_WARNING = "El ticket viaja sin cifrar a Workers AI para leerlo. Si no lo marcás, el ticket se guarda cifrado y lo cargás a mano.";

/** Scan upload. `ai=1` is sent only when the box is checked. Server mode omits the field. */
export function buildReceiptScanForm(input: { file: Blob; filename: string; ai?: boolean }): FormData {
  const form = new FormData();
  form.append("file", input.file, input.filename);
  if (input.ai === true) form.append("ai", "1");
  return form;
}

/** Server note for a stored ticket that skipped AI. Empty for the normal read / unread cases. */
export function scanInfoNote(data: { ok?: boolean; aiStatus?: string | null; message?: string | null }): string {
  if (data.ok !== false) return "";
  if (data.aiStatus !== "disabled" && data.aiStatus !== "global_limit") return "";
  return typeof data.message === "string" ? data.message : "";
}
