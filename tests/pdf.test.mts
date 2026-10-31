import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { PdfDoc, wrapText, winAnsi, approxMeasure, helveticaMeasure } from "../lib/pdf.ts";
import { ACCENT, buildDocumentPdf, fileName, formatMoney, formatQty, tintLogo, type PdfDocData } from "../lib/document-pdf.ts";

const text = (u: Uint8Array) => Buffer.from(u).toString("latin1");
const data = (o: Partial<PdfDocData> = {}): PdfDocData => ({ type: "invoice", number: 7, status: "sent", issueDate: "2026-10-01", dueDate: "2026-10-16", currency: "ARS", notes: "Gracias", paidAt: null, contactName: "Ñandú S.A.", contactEmail: "a@b.co", contactPhone: null, items: [{ description: "Diseño (landing) \\ v2", quantityMilli: 2500, unitPriceMinor: 1_500_000 }], ...o });
const opts = { issuerName: "Luciano", today: "2026-10-30" };

test("winAnsi escapes delimiters and maps accents and dashes", () => {
  assert.deepEqual(winAnsi("(a)"), [0x5c, 0x28, 0x61, 0x5c, 0x29]);
  assert.deepEqual(winAnsi("ñ"), [0xf1]);
  assert.deepEqual(winAnsi("—·"), [0x97, 0xb7]);
  assert.deepEqual(winAnsi("🚀"), [0x3f]);
});

test("PDF is structurally valid: xref offsets point at objects", () => {
  const pdf = new PdfDoc();
  const p = pdf.addPage();
  p.text(50, 50, "Hola"); p.rect(0, 0, 10, 10, "#fe4aab"); p.line(0, 0, 5, 5, "#000000");
  const img = pdf.addImage({ width: 2, height: 2, rgb: new Uint8Array(12), flate: deflateSync(Buffer.alloc(12)) });
  p.image(img, 0, 0, 10, 10);
  const bytes = pdf.bytes(); const s = text(bytes);
  assert.ok(s.startsWith("%PDF-1.4") && s.trimEnd().endsWith("%%EOF"));
  const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]);
  assert.equal(s.slice(xrefAt, xrefAt + 4), "xref");
  const entries = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.match(s, /\/Filter \/FlateDecode/);
});

test("invoice PDF contains the data, the brand footer and the internal-voucher disclaimer", () => {
  const s = text(buildDocumentPdf(data(), opts));
  assert.match(s, /\(Factura\) Tj/); assert.match(s, /N° F-0007|N\\260 F-0007/);
  assert.match(s, /\\321and\\372 S\.A\./); // Ñandú in WinAnsi octal
  assert.match(s, /Comprobante interno/); assert.match(s, /no es una factura fiscal \\\(ARCA\\\)/);
  assert.match(s, /Diseño|Dise\\361o/); assert.match(s, /Diseñ|Dise\\361o \\\(landing\\\) \\\\ v2/);
  assert.match(s, /\$ 37\.500,00/);
  assert.match(s, /Vencida/, "sent + past due is shown as Vencida");
});

test("quote, paid and void variants", () => {
  assert.match(text(buildDocumentPdf(data({ type: "quote", number: 3, status: "draft" }), opts)), /\(Presupuesto\) Tj/);
  assert.match(text(buildDocumentPdf(data({ status: "paid", paidAt: "2026-10-20" }), opts)), /Cobrada \\267 20\/10\/2026/);
  assert.match(text(buildDocumentPdf(data({ status: "void" }), opts)), /Anulada/);
});

test("many items paginate and every page has a footer", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ description: "Ítem número " + i + " con una descripción larga para que ocupe más de una línea en la tabla del comprobante", quantityMilli: 1000, unitPriceMinor: 100 }));
  const s = text(buildDocumentPdf(data({ items }), opts));
  const pages = (/\/Count (\d+)/.exec(s)![1]);
  assert.ok(Number(pages) >= 3);
  assert.equal([...s.matchAll(/Comprobante interno/g)].length, Number(pages));
  assert.match(s, /TOTAL ARS/);
});

test("helpers: wrapText, money, quantity, file name", () => {
  const lines = wrapText("uno dos tres cuatro cinco", 60, 10, "regular", approxMeasure);
  assert.ok(lines.length > 1 && lines.every((l) => approxMeasure(l, 10, "regular") <= 60));
  assert.equal(wrapText("a".repeat(100), 50, 10, "regular", approxMeasure).length > 1, true);
  assert.deepEqual(wrapText("", 50, 10, "regular", approxMeasure), [""]);
  assert.equal(formatMoney(123456, "ARS").replace(/\s/g, " "), "$ 1.234,56");
  assert.equal(formatMoney(5000, "USD").replace(/\s/g, " "), "US$ 50,00");
  assert.equal(formatQty(2500), "2,5");
  assert.equal(fileName({ type: "invoice", number: 7, contactName: "Ñandú S.A." }), "Factura-F-0007-Nandu-S-A.pdf");
  assert.equal(fileName({ type: "quote", number: 1, contactName: null }), "Presupuesto-P-0001.pdf");
});

const rgbOps = (s: string) => new Set([...s.matchAll(/([\d.]+ [\d.]+ [\d.]+) (?:rg|RG)\b/g)].map((m) => m[1]));
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" "); };
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

test("unicolor design: white page, one cyan accent, no black or filled blocks", () => {
  const s = text(buildDocumentPdf(data({ notes: "n" }), opts));
  assert.doesNotMatch(s, / re f/, "no filled rectangles (no black band, no total box, no color stripe)");
  const colors = rgbOps(s);
  const allowed = new Set([ACCENT.brand, ACCENT.ink, "#17171c", "#62626e", "#9a9aa6", "#e4e4ea"].map(rgbOf));
  for (const c of colors) assert.ok(allowed.has(c), `unexpected color ${c}`);
  assert.ok(colors.has(rgbOf(ACCENT.ink)) && colors.has(rgbOf(ACCENT.brand)));
  assert.deepEqual([ACCENT.brand, ACCENT.ink], ["#39c5ff", "#007bae"]);
});

test("accent text colors pass WCAG AA (4.5:1) on white", () => {
  assert.ok(1.05 / (lum(ACCENT.ink) + 0.05) >= 4.5, ACCENT.ink);
  for (const gray of ["#17171c", "#62626e"]) assert.ok(1.05 / (lum(gray) + 0.05) >= 4.5, gray);
});

test("tintLogo: black becomes white, bright becomes the accent", () => {
  const out = tintLogo(new Uint8Array([0, 0, 0, 255, 255, 255]), "#ab96ff");
  assert.deepEqual([...out.slice(0, 3)], [255, 255, 255]);
  assert.deepEqual([...out.slice(3)], [0xab, 0x96, 0xff]);
});

test("helveticaMeasure uses real Helvetica widths", () => {
  assert.equal(Math.round(helveticaMeasure("Hello", 10, "regular") * 100) / 100, 22.78);
  assert.equal(helveticaMeasure("ñ", 10, "regular"), 5.56);
  assert.ok(helveticaMeasure("Total", 10, "bold") > helveticaMeasure("Total", 10, "regular"));
  assert.equal(helveticaMeasure("—", 10, "regular"), 10);
});
