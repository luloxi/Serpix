// Layout of a presupuesto / factura PDF with Serpix branding. Pure: caller supplies measure() and the optional logo.
import { PdfDoc, wrapText, PAGE_W, PAGE_H, type Measure, type PdfImage, type PdfPage } from "./pdf.ts";
import { formatNumber, typeLabel, lineTotalMinor, displayStatus, STATUS_LABEL, type DocType, type DocStatus, type DocCurrency } from "./documents.ts";

export const BRAND = { pink: "#fe4aab", cyan: "#39c5ff", yellow: "#f6cd35", violet: "#ab96ff", ink: "#12111c" };
export const DISCLAIMER = "Comprobante interno · no es una factura fiscal (ARCA)";

export type PdfDocData = {
  type: DocType; number: number; status: DocStatus; issueDate: string; dueDate: string | null; currency: DocCurrency; notes: string | null; paidAt: string | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  items: { description: string; quantityMilli: number; unitPriceMinor: number }[];
};

export function formatMoney(minor: number, currency: string): string {
  const n = (minor / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (currency === "USD" ? "US$ " : "$ ") + n;
}
export const formatDate = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
export const formatQty = (milli: number) => (milli / 1000).toLocaleString("es-AR", { maximumFractionDigits: 3 });

export function fileName(d: { type: DocType; number: number; contactName: string | null }): string {
  const who = (d.contactName ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `${typeLabel(d.type)}-${formatNumber(d.type, d.number)}${who ? "-" + who : ""}.pdf`;
}

export function buildDocumentPdf(d: PdfDocData, o: { measure: Measure; issuerName: string; issuerEmail?: string | null; today: string; logo?: PdfImage }): Uint8Array {
  const number = formatNumber(d.type, d.number);
  const doc = new PdfDoc(o.measure, { title: `${typeLabel(d.type)} ${number}`, author: o.issuerName });
  const logoIdx = o.logo ? doc.addImage(o.logo) : -1;
  const L = 36, R = PAGE_W - 36, GRAY = "#5b5870", LINE = "#e6e2f4", SOFT = "#f3f0ff";
  const m = o.measure;
  let page = doc.addPage();
  const footer = (p: PdfPage, n: number, of: number) => {
    p.line(L, 52, R, 52, LINE);
    p.text(L, 38, DISCLAIMER, { size: 8, color: GRAY });
    p.text(R, 38, `Serpix · ${number} · ${n}/${of}`, { size: 8, color: GRAY, align: "right" });
  };

  // Header band
  page.rect(0, PAGE_H - 100, PAGE_W, 100, "#000000");
  if (logoIdx >= 0) page.image(logoIdx, L, PAGE_H - 88, 76, 76);
  const tx = logoIdx >= 0 ? L + 92 : L;
  page.text(tx, PAGE_H - 52, typeLabel(d.type), { size: 26, font: "bold", color: "#ffffff" });
  page.text(tx, PAGE_H - 74, `N° ${number}`, { size: 14, font: "bold", color: BRAND.yellow });
  page.text(R, PAGE_H - 50, o.issuerName.slice(0, 40), { size: 12, font: "bold", color: "#ffffff", align: "right" });
  if (o.issuerEmail) page.text(R, PAGE_H - 66, o.issuerEmail.slice(0, 50), { size: 9, color: "#c9c5dd", align: "right" });
  const sw = PAGE_W / 4;
  [BRAND.pink, BRAND.violet, BRAND.cyan, BRAND.yellow].forEach((c, i) => page.rect(i * sw, PAGE_H - 106, sw + 0.5, 6, c));

  // Client + dates
  let y = PAGE_H - 140;
  page.text(L, y, "CLIENTE", { size: 8, font: "bold", color: "#6b53d9" });
  page.text(L, y - 18, (d.contactName || "Sin cliente").slice(0, 60), { size: 14, font: "bold", color: BRAND.ink });
  let cy = y - 33;
  for (const line of [d.contactEmail, d.contactPhone]) if (line) { page.text(L, cy, line.slice(0, 60), { size: 9.5, color: GRAY }); cy -= 13; }
  const rows: [string, string][] = [["Fecha", formatDate(d.issueDate)], ["Vencimiento", d.dueDate ? formatDate(d.dueDate) : "—"], ["Moneda", d.currency]];
  const st = displayStatus({ type: d.type, status: d.status, dueDate: d.dueDate }, o.today);
  rows.push(["Estado", STATUS_LABEL[st] + (st === "paid" && d.paidAt ? " · " + formatDate(d.paidAt) : "")]);
  let ry = y;
  for (const [k, v] of rows) {
    page.text(R - 120, ry, k, { size: 9, color: GRAY });
    const color = k === "Estado" ? (st === "paid" ? "#0a7bb0" : st === "overdue" || st === "void" ? "#c4262e" : BRAND.ink) : BRAND.ink;
    page.text(R, ry, v, { size: 10, font: "bold", color, align: "right" });
    ry -= 15;
  }
  y = Math.min(cy, ry) - 24;

  // Items table
  const cQty = 372, cPrice = 462, descW = cQty - 50 - L - 8;
  const head = (p: PdfPage, at: number) => {
    p.rect(L, at - 6, R - L, 22, SOFT);
    p.text(L + 8, at, "DESCRIPCIÓN", { size: 8, font: "bold", color: "#4b3bb0" });
    p.text(cQty, at, "CANT.", { size: 8, font: "bold", color: "#4b3bb0", align: "right" });
    p.text(cPrice, at, "PRECIO", { size: 8, font: "bold", color: "#4b3bb0", align: "right" });
    p.text(R - 8, at, "IMPORTE", { size: 8, font: "bold", color: "#4b3bb0", align: "right" });
  };
  head(page, y);
  y -= 26;
  let total = 0;
  for (const it of d.items) {
    const lines = wrapText(it.description, descW, 10, "regular", m);
    const h = lines.length * 13 + 16;
    if (y - h < 150) { page = doc.addPage(); y = PAGE_H - 60; head(page, y); y -= 26; }
    const amount = lineTotalMinor(it.quantityMilli, it.unitPriceMinor);
    total += amount;
    lines.forEach((ln, i) => page.text(L + 8, y - i * 13, ln, { size: 10, color: BRAND.ink }));
    page.text(cQty, y, formatQty(it.quantityMilli), { size: 10, color: BRAND.ink, align: "right" });
    page.text(cPrice, y, formatMoney(it.unitPriceMinor, d.currency), { size: 10, color: BRAND.ink, align: "right" });
    page.text(R - 8, y, formatMoney(amount, d.currency), { size: 10, font: "bold", color: BRAND.ink, align: "right" });
    y -= h;
    page.line(L, y + 10, R, y + 10, LINE);
  }

  // Total
  if (y < 190) { page = doc.addPage(); y = PAGE_H - 70; }
  y -= 14;
  page.rect(R - 210, y - 14, 210, 40, "#000000");
  page.rect(R - 210, y - 14, 5, 40, BRAND.yellow);
  page.text(R - 196, y + 2, "TOTAL " + d.currency, { size: 9, font: "bold", color: "#c9c5dd" });
  page.text(R - 10, y + 2, formatMoney(total, d.currency), { size: 15, font: "bold", color: BRAND.yellow, align: "right" });
  y -= 44;

  // Notes
  if (d.notes) {
    const nl = wrapText(d.notes, R - L, 9.5, "regular", m).slice(0, 14);
    if (y - nl.length * 12 - 30 < 70) { page = doc.addPage(); y = PAGE_H - 70; }
    page.text(L, y, "NOTAS", { size: 8, font: "bold", color: "#6b53d9" });
    nl.forEach((ln, i) => page.text(L, y - 15 - i * 12, ln, { size: 9.5, color: GRAY }));
  }
  doc.pages.forEach((p, i) => footer(p, i + 1, doc.pages.length));
  return doc.bytes();
}
