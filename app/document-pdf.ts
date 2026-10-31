// Browser side of the PDF: loads the v5 logo (tinted to the accent) and builds the file with lib/document-pdf.ts (no server, no paid service).
import { ACCENT, buildDocumentPdf, fileName, formatMoney, tintLogo, type PdfDocData } from "@/lib/document-pdf";
import { itemsTotalMinor, formatNumber, typeLabel } from "@/lib/documents";
import type { PdfImage } from "@/lib/pdf";

let logoPromise: Promise<PdfImage | undefined> | null = null;

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Logo v5 as a single-color mark in the PDF accent (white background), zlib-compressed. */
function loadLogo(): Promise<PdfImage | undefined> {
  logoPromise ??= (async () => {
    try {
      const blob = await (await fetch("/icons/icon-192.v5.png")).blob();
      const bmp = await createImageBitmap(blob);
      const size = 192;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);
      const rgba = ctx.getImageData(0, 0, size, size).data;
      const black = new Uint8Array(size * size * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) { black[j++] = rgba[i]; black[j++] = rgba[i + 1]; black[j++] = rgba[i + 2]; }
      const rgb = tintLogo(black, ACCENT.brand);
      return { width: size, height: size, rgb, flate: await deflate(rgb) };
    } catch { return undefined; } // the PDF is still valid without the logo
  })();
  return logoPromise;
}

export type ShareableDoc = PdfDocData & { id: string };

export async function renderPdf(doc: PdfDocData, issuer: { name: string; email: string | null }, today: string): Promise<Blob> {
  const logo = await loadLogo();
  const bytes = buildDocumentPdf(doc, { issuerName: issuer.name, issuerEmail: issuer.email, today, logo });
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function shareText(doc: PdfDocData): string {
  const total = formatMoney(itemsTotalMinor(doc.items), doc.currency);
  const hi = doc.contactName ? `Hola ${doc.contactName.split(" ")[0]}, ` : "Hola, ";
  return `${hi}te paso el ${typeLabel(doc.type).toLowerCase()} ${formatNumber(doc.type, doc.number)} por ${total}. Comprobante interno.`;
}

/** Web Share with the PDF file when the device supports it; otherwise downloads the PDF and opens WhatsApp with a short message. Never sends anything by itself. */
export async function sharePdf(blob: Blob, doc: PdfDocData, phone: string | null): Promise<"shared" | "whatsapp" | "cancelled"> {
  const name = fileName(doc);
  const file = new File([blob], name, { type: "application/pdf" });
  const text = shareText(doc);
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name, text }); return "shared"; }
    catch (e) { if (e instanceof DOMException && e.name === "AbortError") return "cancelled"; }
  }
  downloadBlob(blob, name);
  window.open(`https://wa.me/${phone ?? ""}?text=${encodeURIComponent(text + " (adjunto el PDF)")}`, "_blank", "noopener");
  return "whatsapp";
}
