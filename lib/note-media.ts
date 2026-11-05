// Note images for server-mode accounts. Same shape as receipts: owner-only bytes in D1, no R2 binding.
// Encrypted accounts do not use this table. Their images stay inside activities.body and travel with the ciphertext.

export const NOTE_MEDIA_MAX_BYTES = 500_000;
export const NOTE_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const NOTE_MEDIA_TOO_BIG = "La imagen pesa demasiado (máx. 500 KB).";
export const NOTE_MEDIA_TYPE = "Formato no admitido. Usá JPG, PNG o WebP.";

const MEDIA_PATH = /^\/api\/note-media\/([A-Za-z0-9_-]{1,80})$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function isNoteImageMime(value: string): boolean {
  return (NOTE_IMAGE_MIMES as readonly string[]).includes(value);
}

export function isNoteMediaId(value: string): boolean {
  return MEDIA_ID.test(value);
}

export function noteMediaPath(id: string): string {
  return `/api/note-media/${id}`;
}

export function isNoteMediaPath(value: string): boolean {
  return MEDIA_PATH.test(value);
}
