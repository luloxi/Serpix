// Tiny PDF writer (no dependencies, no paid services): A4 pages, Helvetica / Helvetica-Bold, rectangles, lines, text, RGB images.
// Text is written in WinAnsi (accents, ñ, ·, —). Runs in the browser and in Node (tests).

export type Font = "regular" | "bold";
export type Align = "left" | "right" | "center";
export type Measure = (text: string, size: number, font: Font) => number;
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

/** Rough Helvetica width (used when no measure function is given, e.g. in tests). */
export const approxMeasure: Measure = (text, size, font) => text.length * size * (font === "bold" ? 0.56 : 0.52);

const WIN_ANSI_EXTRA: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

/** JS string -> escaped PDF literal string bytes (without the parentheses). */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let b: number;
    if (cp === 0x28 || cp === 0x29 || cp === 0x5c) { out.push(0x5c, cp); continue; }
    if (cp >= 0x20 && cp < 0x7f) b = cp;
    else if (cp >= 0xa0 && cp <= 0xff) b = cp;
    else if (WIN_ANSI_EXTRA[ch] !== undefined) b = WIN_ANSI_EXTRA[ch];
    else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) b = 0x20;
    else b = 0x3f; // "?"
    out.push(b);
  }
  return out;
}

const hex = (c: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) throw new Error("bad color " + c);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
};
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export type PdfImage = { width: number; height: number; rgb: Uint8Array; flate?: Uint8Array };

export class PdfPage {
  ops: string[] = [];
  images = new Set<number>();
  private doc: PdfDoc;
  constructor(doc: PdfDoc) { this.doc = doc; }
  rect(x: number, y: number, w: number, h: number, fill: string) {
    this.ops.push(`${hex(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: string, width = 0.6) {
    this.ops.push(`${hex(color)} RG ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }
  text(x: number, y: number, text: string, o: { size?: number; font?: Font; color?: string; align?: Align } = {}) {
    const size = o.size ?? 10, font = o.font ?? "regular";
    let tx = x;
    if (o.align && o.align !== "left") {
      const w = this.doc.measure(text, size, font);
      tx = o.align === "right" ? x - w : x - w / 2;
    }
    const bytes = winAnsi(text).map((b) => (b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("");
    this.ops.push(`BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${hex(o.color ?? "#000000")} rg ${num(tx)} ${num(y)} Td (${bytes}) Tj ET`);
  }
  image(index: number, x: number, y: number, w: number, h: number) {
    this.images.add(index);
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im${index} Do Q`);
  }
}

export class PdfDoc {
  pages: PdfPage[] = [];
  images: PdfImage[] = [];
  measure: Measure;
  info: { title?: string; author?: string };
  constructor(measure: Measure = approxMeasure, info: { title?: string; author?: string } = {}) { this.measure = measure; this.info = info; }
  addPage() { const p = new PdfPage(this); this.pages.push(p); return p; }
  addImage(img: PdfImage): number { this.images.push(img); return this.images.length - 1; }

  bytes(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const enc = new TextEncoder();
    let length = 0;
    const offsets: number[] = [];
    const push = (u: Uint8Array) => { chunks.push(u); length += u.length; };
    const pushStr = (s: string) => push(enc.encode(s)); // ASCII only here
    pushStr("%PDF-1.4\n");
    const obj = (n: number, body: () => void) => { offsets[n] = length; pushStr(`${n} 0 obj\n`); body(); pushStr("\nendobj\n"); };
    // Layout: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then images, then per page (page obj, content obj).
    const imgBase = 6;
    const pageBase = imgBase + this.images.length;
    const total = pageBase + this.pages.length * 2;
    obj(1, () => pushStr("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, () => pushStr(`<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(" ")}] >>`));
    obj(3, () => pushStr("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
    obj(4, () => pushStr("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
    const meta = (s: string) => "(" + winAnsi(s).map((b) => (b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("") + ")";
    obj(5, () => pushStr(`<< /Title ${meta(this.info.title ?? "")} /Author ${meta(this.info.author ?? "")} /Producer (Serpix) >>`));
    this.images.forEach((img, i) => obj(imgBase + i, () => {
      const data = img.flate ?? img.rgb;
      pushStr(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${img.flate ? " /Filter /FlateDecode" : ""} /Length ${data.length} >>\nstream\n`);
      push(data);
      pushStr("\nendstream");
    }));
    this.pages.forEach((page, i) => {
      const content = enc.encode(page.ops.join("\n"));
      const xo = [...page.images].map((k) => `/Im${k} ${imgBase + k} 0 R`).join(" ");
      obj(pageBase + i * 2, () => pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ""} >> /Contents ${pageBase + i * 2 + 1} 0 R >>`));
      obj(pageBase + i * 2 + 1, () => { pushStr(`<< /Length ${content.length} >>\nstream\n`); push(content); pushStr("\nendstream"); });
    });
    const xref = length;
    pushStr(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let n = 1; n < total; n++) pushStr(String(offsets[n]).padStart(10, "0") + " 00000 n \n");
    pushStr(`trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

/** Greedy word wrap with a measure function. Very long words are cut. */
export function wrapText(text: string, maxWidth: number, size: number, font: Font, measure: Measure): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (measure(w, size, font) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut), size, font) > maxWidth) cut--;
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = cur ? cur + " " + w : w;
      if (measure(next, size, font) <= maxWidth) cur = next;
      else { if (cur) lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines.length ? lines : [""];
}
