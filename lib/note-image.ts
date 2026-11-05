// Browser-only. Shrinks a note photo before it is uploaded or embedded in the encrypted note body.
export const NOTE_IMAGE_MAX_BYTES = 180_000;

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Re-encodes as JPEG, long side at most 1600 px, until the file is small enough to live in a note. */
export async function shrinkNoteImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("No pude leer esa imagen. Usá JPG, PNG o WebP.");
  }
  try {
    let maxSide = 1600;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.68, 0.52, 0.4]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob && blob.size <= NOTE_IMAGE_MAX_BYTES) return blob;
      }
      maxSide = Math.round(maxSide * 0.65);
    }
  } finally {
    bitmap.close();
  }
  throw new Error("La imagen sigue siendo muy pesada.");
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}
