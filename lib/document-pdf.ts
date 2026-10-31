// Layout of a presupuesto / factura PDF: white page, ONE accent color, grays for everything else. Pure: caller supplies the optional logo.
import { PdfDoc, wrapText, helveticaMeasure, PAGE_W, PAGE_H, type Measure, type PdfImage, type PdfPage } from "./pdf.ts";
import { formatNumber, typeLabel, lineTotalMinor, displayStatus, STATUS_LABEL, type DocType, type DocStatus, type DocCurrency } from "./documents.ts";

/**
 * The single accent of the PDF (--brand-cyan). `brand` is the Serpix color (logo, rules); `ink` is the same hue darkened until it passes
 * WCAG AA (>= 4.5:1) on white, used for every piece of accent-colored text.
 */
export const ACCENT = { brand: "#39c5ff", ink: "#007bae" } as const;

const TEXT = "#17171c", MUTED = "#62626e", FAINT = "#9a9aa6", HAIRLINE = "#e4e4ea";
export const DISCLAIMER = "Comprobante interno · no es una factura fiscal (ARCA)";

const hexToRgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** The v5 logo (thick ouroboros + $ on black) as a single-color mark: brightness becomes the amount of accent over white. */
export function tintLogo(rgbOverBlack: Uint8Array, accentHex: string): Uint8Array {
  const [r, g, b] = hexToRgb(accentHex);
  const out = new Uint8Array(rgbOverBlack.length);
  for (let i = 0; i < rgbOverBlack.length; i += 3) {
    const m = Math.min(1, (Math.max(rgbOverBlack[i], rgbOverBlack[i + 1], rgbOverBlack[i + 2]) / 255) * 1.1);
    out[i] = Math.round(255 - m * (255 - r)); out[i + 1] = Math.round(255 - m * (255 - g)); out[i + 2] = Math.round(255 - m * (255 - b));
  }
  return out;
}

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

export function buildDocumentPdf(d: PdfDocData, o: { measure?: Measure; issuerName: string; issuerEmail?: string | null; today: string; logo?: PdfImage }): Uint8Array {
  const number = formatNumber(d.type, d.number);
  const m = o.measure ?? helveticaMeasure;
  const A = ACCENT;
  const doc = new PdfDoc(m, { title: `${typeLabel(d.type)} ${number}`, author: o.issuerName });
  const logoIdx = o.logo ? doc.addImage(o.logo) : -1;
  const L = 56, R = PAGE_W - 56, TOP = PAGE_H - 56;
  let page = doc.addPage();
  const label = (p: PdfPage, x: number, y: number, t: string, align: "left" | "right" = "left") => p.text(x, y, t, { size: 7.5, font: "bold", color: FAINT, spacing: 0.9, align });

  // Header: small monochrome mark on the left, issuer on the right.
  if (logoIdx >= 0) page.image(logoIdx, L - 2, TOP - 34, 34, 34);
  page.text(R, TOP - 10, o.issuerName.slice(0, 40), { size: 10.5, font: "bold", color: TEXT, align: "right" });
  if (o.issuerEmail) page.text(R, TOP - 24, o.issuerEmail.slice(0, 50), { size: 9, color: MUTED, align: "right" });

  // Title
  page.text(L, TOP - 92, typeLabel(d.type), { size: 28, font: "bold", color: TEXT });
  page.text(L, TOP - 114, `N° ${number}`, { size: 12, font: "bold", color: A.ink });
  page.line(L, TOP - 134, R, TOP - 134, A.brand, 1);

  // Client + dates
  const y0 = TOP - 170;
  label(page, L, y0, "CLIENTE");
  page.text(L, y0 - 20, (d.contactName || "Sin cliente").slice(0, 60), { size: 13, font: "bold", color: TEXT });
  let cy = y0 - 35;
  for (const line of [d.contactEmail, d.contactPhone]) if (line) { page.text(L, cy, line.slice(0, 60), { size: 9.5, color: MUTED }); cy -= 14; }
  const st = displayStatus({ type: d.type, status: d.status, dueDate: d.dueDate }, o.today);
  const rows: [string, string][] = [["Fecha", formatDate(d.issueDate)], ["Vencimiento", d.dueDate ? formatDate(d.dueDate) : "—"], ["Moneda", d.currency], ["Estado", STATUS_LABEL[st] + (st === "paid" && d.paidAt ? " · " + formatDate(d.paidAt) : "")]];
  let ry = y0;
  for (const [k, v] of rows) {
    page.text(R - 150, ry, k, { size: 9, color: MUTED });
    page.text(R, ry, v, { size: 9.5, color: TEXT, align: "right" });
    ry -= 17;
  }
  let y = Math.min(cy, ry) - 38;

  // Items table: gray caps header, hairlines, no fills.
  const cQty = 330, cPrice = 424, descW = cQty - 44 - L;
  const head = (p: PdfPage, at: number) => {
    label(p, L, at, "DESCRIPCIÓN"); label(p, cQty, at, "CANT.", "right"); label(p, cPrice, at, "PRECIO", "right"); label(p, R, at, "IMPORTE", "right");
    p.line(L, at - 10, R, at - 10, HAIRLINE, 0.6);
  };
  head(page, y);
  y -= 32;
  let total = 0;
  for (const it of d.items) {
    const lines = wrapText(it.description, descW, 10, "regular", m);
    const h = lines.length * 13 + 19;
    if (y - h < 120) { page = doc.addPage(); y = TOP - 14; head(page, y); y -= 32; }
    const amount = lineTotalMinor(it.quantityMilli, it.unitPriceMinor);
    total += amount;
    lines.forEach((ln, i) => page.text(L, y - i * 13, ln, { size: 10, color: TEXT }));
    page.text(cQty, y, formatQty(it.quantityMilli), { size: 10, color: MUTED, align: "right" });
    page.text(cPrice, y, formatMoney(it.unitPriceMinor, d.currency), { size: 10, color: MUTED, align: "right" });
    page.text(R, y, formatMoney(amount, d.currency), { size: 10, color: TEXT, align: "right" });
    y -= h;
    page.line(L, y + 11, R, y + 11, HAIRLINE, 0.5);
  }

  // Total: typography only, one accent rule above.
  if (y < 170) { page = doc.addPage(); y = TOP - 14; }
  y -= 18;
  page.line(R - 190, y + 6, R, y + 6, A.brand, 1);
  label(page, R, y - 14, "TOTAL " + d.currency, "right");
  page.text(R, y - 40, formatMoney(total, d.currency), { size: 22, font: "bold", color: A.ink, align: "right" });
  y -= 92;

  // Notes
  if (d.notes) {
    const nl = wrapText(d.notes, R - L, 9.5, "regular", m).slice(0, 14);
    if (y - nl.length * 13 - 30 < 70) { page = doc.addPage(); y = TOP - 14; }
    label(page, L, y, "NOTAS");
    nl.forEach((ln, i) => page.text(L, y - 17 - i * 13, ln, { size: 9.5, color: MUTED }));
  }
  doc.pages.forEach((p, i) => {
    p.text(L, 36, DISCLAIMER, { size: 7.5, color: FAINT });
    p.text(R, 36, `${number} · ${i + 1}/${doc.pages.length}`, { size: 7.5, color: FAINT, align: "right" });
  });
  return doc.bytes();
}
