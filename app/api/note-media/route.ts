import { NextResponse } from "next/server";
import { isNoteImageMime, NOTE_MEDIA_MAX_BYTES, NOTE_MEDIA_TOO_BIG, NOTE_MEDIA_TYPE, noteMediaPath } from "@/lib/note-media";
import { sniffMime } from "@/lib/receipts-db";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext } from "@/lib/session";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** Stores one note image for its owner. Encrypted accounts get 403 and keep the bytes inside the note instead. */
export async function POST(request: Request) {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "Archivo inválido" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Falta el archivo" }, 400);
  if (file.size <= 0) return json({ error: "Archivo inválido" }, 400);
  if (file.size > NOTE_MEDIA_MAX_BYTES) return json({ error: NOTE_MEDIA_TOO_BIG }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !isNoteImageMime(mime)) return json({ error: NOTE_MEDIA_TYPE }, 415);
  const data = Buffer.from(bytes).toString("base64");
  const id = crypto.randomUUID();
  try {
    await ctx.db.prepare("INSERT INTO note_media (id,user_id,mime,size,data,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, ctx.userId, mime, bytes.length, data, Date.now()).run();
  } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    console.error("note_media_insert_failed");
    return json({ error: "No se pudo guardar la imagen" }, 500);
  }
  return json({ id, url: noteMediaPath(id) }, 201);
}
