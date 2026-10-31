import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AI_READ_LABEL, AI_READ_WARNING, buildReceiptScanForm } from "../lib/receipt-client.ts";

test("the scan form sends ai=1 only when the box is checked", () => {
  const file = new Blob(["ticket"], { type: "image/jpeg" });
  const plain = buildReceiptScanForm({ file, filename: "ticket.jpg" });
  assert.equal(plain.get("ai"), null);
  assert.equal((plain.get("file") as File).name, "ticket.jpg");

  const off = buildReceiptScanForm({ file, filename: "ticket.pdf", ai: false });
  assert.equal(off.get("ai"), null);
  assert.equal((off.get("file") as File).name, "ticket.pdf");

  const on = buildReceiptScanForm({ file, filename: "ticket.jpg", ai: true });
  assert.equal(on.get("ai"), "1");
  assert.equal(on.getAll("ai").length, 1);

  assert.equal(AI_READ_LABEL, "Leer el ticket con IA");
  assert.equal(AI_READ_WARNING, "El ticket viaja sin cifrar a Workers AI para leerlo. Si no lo marcás, el ticket se guarda cifrado y lo cargás a mano.");
});

test("the ticket field shows the checkbox only for an e2e session and starts unchecked", () => {
  const source = readFileSync(new URL("../app/receipt-field.tsx", import.meta.url), "utf8");
  assert.match(source, /useState\(false\)/);
  assert.match(source, /e2e && readWithAi/);
  assert.match(source, /\{e2e && \(/);
  assert.match(source, /AI_READ_LABEL/);
  assert.match(source, /AI_READ_WARNING/);
  assert.match(source, /className="e2e-ai"/);
  assert.equal(source.includes('value="1"'), false);
  assert.equal(source.includes("ai=1"), false);
});
