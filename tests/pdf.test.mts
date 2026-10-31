import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { PdfDoc, wrapText, winAnsi, approxMeasure } from "../lib/pdf.ts";
import { buildDocumentPdf, fileName, formatMoney, formatQty, type PdfDocData } from "../lib/document-pdf.ts";

const text = (u: Uint8Array) => Buffer.from(u).toString("latin1");
const data = (o: Partial<PdfDocData> = {}): PdfDocData => ({ type: "invoice", number: 7, status: "sent", issueDate: "2026-10-01", dueDate: "2026-10-16", currency: "ARS", notes: "Gracias", paidAt: null, contactName: "Ñandú S.A.", contactEmail: "a@b.co", contactPhone: null, items: [{ description: "Diseño (landing) \\ v2", quantityMilli: 2500, unitPriceMinor: 1_500_000 }], ...o });
const opts = { measure: approxMeasure, issuerName: "Luciano", today: "2026-10-30" };

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
  for (const hex of ["0.996 0.290 0.671", "0.224 0.773 1.000", "0.965 0.804 0.208", "0.671 0.588 1.000"]) assert.ok(s.includes(hex), "palette " + hex);
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
