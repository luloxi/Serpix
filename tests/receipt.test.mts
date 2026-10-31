import test from "node:test";
import assert from "node:assert/strict";
import { scanInfoNote } from "../lib/receipt-client.ts";
import { RECEIPT_MODEL, parseAmountMinor, parseDateLoose, parseReceiptReply, readReceipt, type AiLike } from "../lib/receipt.ts";
import { attachReceipt, isReceiptMime, overScanLimit, purgeOrphanReceipts, scansToday, sniffMime } from "../lib/receipts-db.ts";
import { account, openDb, user } from "./db-helper.mts";

const TODAY = "2026-10-31";
type Call = { messages: { content: { text?: string; image_url?: { url: string } }[] }[] };

test("parseAmountMinor handles Argentine and US formats", () => {
  assert.equal(parseAmountMinor(16760.5), 1676050);
  assert.equal(parseAmountMinor("16.760,50"), 1676050);
  assert.equal(parseAmountMinor("$ 16.760,50"), 1676050);
  assert.equal(parseAmountMinor("1,234.56"), 123456);
  assert.equal(parseAmountMinor("33.880.00"), 3388000);
  assert.equal(parseAmountMinor("1.234"), 123400);
  assert.equal(parseAmountMinor("12,5"), 1250);
  assert.equal(parseAmountMinor("USD 10.53"), 1053);
  assert.equal(parseAmountMinor("0"), null);
  assert.equal(parseAmountMinor(-5), null);
  assert.equal(parseAmountMinor("abc"), null);
  assert.equal(parseAmountMinor(null), null);
});

test("parseReceiptReply: object, fenced text, bad values", () => {
  const ok = parseReceiptReply({ amount: 16760.5, currency: "ARS", date: "2026-10-28", merchant: "SUPERMERCADO EL TRÉBOL", category: "supermercado" }, TODAY);
  assert.deepEqual(ok, { ok: true, fields: { amountMinor: 1676050, currency: "ARS", date: "2026-10-28", merchant: "SUPERMERCADO EL TRÉBOL", category: "Supermercado" } });
  const fenced = parseReceiptReply('```json\n{"amount":"33.880.00","currency":"$","date":"2026-10-15","merchant":"Telecentro S.A.","category":"Servicios"}\n```\nNota: ...', TODAY);
  assert.equal(fenced.ok && fenced.fields.amountMinor, 3388000);
  assert.equal(fenced.ok && fenced.fields.currency, "ARS");
  const odd = parseReceiptReply({ amount: 10.53, currency: "U$S", date: "2030-01-01", merchant: "null", category: "Otra cosa" }, TODAY);
  assert.deepEqual(odd, { ok: true, fields: { amountMinor: 1053, currency: "USD", date: null, merchant: null, category: null } });
  assert.equal(parseReceiptReply("Lo siento, no puedo ayudarte.", TODAY).ok, false);
  assert.equal(parseReceiptReply({ amount: null, date: null, merchant: null }, TODAY).ok, false);
  assert.equal(parseReceiptReply({ amount: 5, date: "2026-02-30" }, TODAY).ok && true, true);
});

test("readReceipt calls the free-tier vision model with the image and never throws", async () => {
  const calls: { model: string; input: Call }[] = [];
  const ai: AiLike = { async run(model, input) { calls.push({ model, input: input as Call }); return { response: { amount: 100, currency: "ARS", date: "2026-10-30", merchant: "Kiosco", category: "Comida" } }; } };
  const result = await readReceipt(ai, { mime: "image/jpeg", base64: "AAAA" }, TODAY);
  assert.equal(result.ok, true);
  assert.equal(calls[0].model, RECEIPT_MODEL);
  assert.equal(RECEIPT_MODEL, "@cf/meta/llama-3.2-11b-vision-instruct");
  const content = calls[0].input.messages[1].content;
  assert.equal(content[1].image_url?.url, "data:image/jpeg;base64,AAAA");
  const failing: AiLike = { async run() { throw new Error("AiError: 3040 capacity"); } };
  const bad = await readReceipt(failing, { mime: "image/png", base64: "AAAA" }, TODAY);
  assert.equal(bad.ok, false);
});

test("readReceipt PDF: text goes through toMarkdown; an image-only PDF fails cleanly", async () => {
  const seen: string[] = [];
  const ai: AiLike = {
    async toMarkdown() { return [{ data: "# t.pdf\n## Metadata\n- x=1\n\n## Contents\n### Page 1\nTelecentro Factura\nTotal a pagar: $ 33.880,00\nFecha: 15/10/2026" }]; },
    async run(_m, input) { seen.push((input as Call).messages[1].content[0].text ?? ""); return { response: '{"amount":"33.880,00","currency":"ARS","date":"2026-10-15","merchant":"Telecentro","category":"Servicios"}' }; },
  };
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  const r = await readReceipt(ai, { mime: "application/pdf", base64: pdf }, TODAY);
  assert.equal(r.ok && r.fields.amountMinor, 3388000);
  assert.match(seen[0], /Total a pagar/);
  assert.doesNotMatch(seen[0], /Metadata/);
  const empty: AiLike = { async toMarkdown() { return [{ data: "# t.pdf\n## Contents\n### Page 1\n\n" }]; }, async run() { throw new Error("must not run"); } };
  const r2 = await readReceipt(empty, { mime: "application/pdf", base64: pdf }, TODAY);
  assert.deepEqual(r2, { ok: false, reason: "pdf_sin_texto" });
});

test("sniffMime trusts bytes, not the declared type", () => {
  assert.equal(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), "image/png");
  assert.equal(sniffMime(new TextEncoder().encode("%PDF-1.7 ...")), "application/pdf");
  assert.equal(sniffMime(new TextEncoder().encode("<svg onload=alert(1)>")), null);
  assert.equal(sniffMime(new TextEncoder().encode("<html><script>")), null);
  assert.equal(isReceiptMime("image/svg+xml"), false);
});

function seed() {
  const { db, d1 } = openDb();
  db.exec("PRAGMA foreign_keys = ON");
  user(db, "ana");
  user(db, "bob");
  account(db, "a1", "ana");
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES ('t1','ana','a1','expense',100,'x','2026-10-01',1)").run();
  const receipt = (id: string, userId: string, tx: string | null, created: number) => db.prepare("INSERT INTO receipts (id,user_id,transaction_id,mime,size,data,created_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, tx, "image/jpeg", 3, "AAAA", created);
  return { db, d1, receipt };
}

test("attachReceipt links only the owner's free receipt and replaces the previous one", async () => {
  const { db, d1, receipt } = seed();
  receipt("r1", "ana", null, 1);
  receipt("r2", "ana", null, 2);
  receipt("rb", "bob", null, 3);
  assert.equal(await attachReceipt(d1, "ana", "t1", "rb"), false); // someone else's
  assert.equal(await attachReceipt(d1, "ana", "t1", "r1"), true);
  assert.equal(await attachReceipt(d1, "ana", "t1", "r2"), true); // replaces r1
  const rows = db.prepare("SELECT id FROM receipts WHERE transaction_id='t1'").all() as { id: string }[];
  assert.deepEqual(rows.map((r) => r.id), ["r2"]);
  assert.equal(await attachReceipt(d1, "bob", "t1", "r2"), false);
});

test("receipts disappear with their movement; cron purges only old unattached ones; scans per day are capped", async () => {
  const { db, d1, receipt } = seed();
  const now = Date.now();
  receipt("old", "ana", null, now - 3 * 86400000);
  receipt("new", "ana", null, now - 1000);
  receipt("att", "ana", "t1", now - 5 * 86400000);
  assert.equal(await purgeOrphanReceipts(d1, now), 1);
  assert.deepEqual((db.prepare("SELECT id FROM receipts ORDER BY id").all() as { id: string }[]).map((r) => r.id), ["att", "new"]);
  db.prepare("DELETE FROM financial_transactions WHERE id='t1'").run();
  assert.deepEqual((db.prepare("SELECT id FROM receipts ORDER BY id").all() as { id: string }[]).map((r) => r.id), ["new"]);
  assert.equal(await scansToday(d1, "ana", now), 1);
  assert.equal(overScanLimit(59), false);
  assert.equal(overScanLimit(60), true);
});

test("parseDateLoose reads ISO and day-first dates", () => {
  assert.equal(parseDateLoose("2026-10-28"), "2026-10-28");
  assert.equal(parseDateLoose("28/10/2026"), "2026-10-28");
  assert.equal(parseDateLoose("2/10/26"), "2026-10-02");
  assert.equal(parseDateLoose("28-10-2026 18:42"), "2026-10-28");
  assert.equal(parseDateLoose("31/02/2026"), null);
  assert.equal(parseDateLoose("ayer"), null);
  assert.equal(parseDateLoose(null), null);
});

test("scanInfoNote shows only the disabled and global-limit messages", () => {
  assert.equal(scanInfoNote({ ok: true, aiStatus: "disabled", message: "x" }), "");
  assert.equal(scanInfoNote({ ok: false, message: "No pude leerlo" }), "");
  assert.equal(scanInfoNote({ ok: false, aiStatus: "disabled", message: "apagada" }), "apagada");
  assert.equal(scanInfoNote({ ok: false, aiStatus: "global_limit", message: "pausa" }), "pausa");
});
