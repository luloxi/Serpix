import test from "node:test";
import assert from "node:assert/strict";
import { openDb, seedUser, seedContact, seedAccount, seedTask, seedEntry } from "./db-shim.mts";
import { addDays, convertQuote, createDocument, deleteDocument, formatNumber, getDocument, importableTimeEntries, isOverdue, itemFromTimeEntry, itemsTotalMinor, lineTotalMinor, listDocuments, overdueInvoices, parseDocInput, payDocument, setStatus, updateDocument, type DocInput } from "../lib/documents.ts";

const base = (o: Partial<DocInput> = {}): DocInput => ({ type: "invoice", contactId: "c1", issueDate: "2026-10-01", dueDate: "2026-10-16", currency: "ARS", notes: null, items: [{ description: "Diseño", quantityMilli: 2500, unitPriceMinor: 1_000_000 }], ...o });
function setup() {
  const { db, d1 } = openDb();
  seedUser(db, "ana"); seedUser(db, "bob");
  seedContact(db, "c1", "ana", "Cliente Uno"); seedContact(db, "cb", "bob", "Cliente de Bob");
  seedAccount(db, "ars", "ana", "ARS"); seedAccount(db, "usd", "ana", "USD"); seedAccount(db, "bob-ars", "bob", "ARS");
  return { db, d1 };
}
const count = (db: ReturnType<typeof openDb>["db"], sql: string, ...a: string[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);

test("pure helpers: numbers, totals, dates, overdue", () => {
  assert.equal(formatNumber("invoice", 7), "F-0007");
  assert.equal(formatNumber("quote", 12345), "P-12345");
  assert.equal(lineTotalMinor(2500, 1_000_000), 2_500_000);
  assert.equal(lineTotalMinor(333, 100), 33);
  assert.equal(itemsTotalMinor([{ quantityMilli: 1000, unitPriceMinor: 500 }, { quantityMilli: 500, unitPriceMinor: 501 }]), 500 + 251);
  assert.equal(addDays("2026-10-30", 15), "2026-11-14");
  assert.equal(addDays("2026-12-25", 10), "2027-01-04");
  assert.equal(isOverdue({ type: "invoice", status: "sent", dueDate: "2026-10-29" }, "2026-10-30"), true);
  assert.equal(isOverdue({ type: "invoice", status: "sent", dueDate: "2026-10-30" }, "2026-10-30"), false, "due today is not overdue yet");
  assert.equal(isOverdue({ type: "invoice", status: "paid", dueDate: "2026-01-01" }, "2026-10-30"), false);
  assert.equal(isOverdue({ type: "invoice", status: "draft", dueDate: "2026-01-01" }, "2026-10-30"), false);
  assert.equal(isOverdue({ type: "quote", status: "sent", dueDate: "2026-01-01" }, "2026-10-30"), false);
  assert.equal(isOverdue({ type: "invoice", status: "void", dueDate: "2026-01-01" }, "2026-10-30"), false);
});

test("parseDocInput validates the body", () => {
  const ok = parseDocInput({ type: "quote", currency: "USD", items: [{ description: " x ", quantityMilli: 1000, unitPriceMinor: 5 }] }, "2026-10-30");
  assert.ok(ok.ok && ok.value.issueDate === "2026-10-30" && ok.value.items[0].description === "x");
  const bad = (b: unknown) => { const r = parseDocInput(b, "2026-10-30"); assert.ok(!r.ok, JSON.stringify(b)); };
  const item = { description: "x", quantityMilli: 1000, unitPriceMinor: 5 };
  bad(null); bad({ type: "nope", currency: "ARS", items: [item] }); bad({ type: "quote", currency: "EUR", items: [item] });
  bad({ type: "quote", currency: "ARS", items: [] });
  bad({ type: "quote", currency: "ARS", issueDate: "2026-02-31", items: [item] });
  bad({ type: "quote", currency: "ARS", issueDate: "2026-10-10", dueDate: "2026-10-01", items: [item] });
  bad({ type: "quote", currency: "ARS", items: [{ ...item, quantityMilli: 0 }] });
  bad({ type: "quote", currency: "ARS", items: [{ ...item, quantityMilli: 1.5 }] });
  bad({ type: "quote", currency: "ARS", items: [{ ...item, unitPriceMinor: -1 }] });
  bad({ type: "quote", currency: "ARS", items: [{ ...item, description: "  " }] });
  bad({ type: "quote", currency: "ARS", items: [{ ...item, unitPriceMinor: 0 }] }); // total must be > 0
  bad({ type: "quote", currency: "ARS", items: Array.from({ length: 101 }, () => item) });
});

test("numbers are correlative per user and per type", async () => {
  const { d1 } = setup();
  const a = await createDocument(d1, "ana", base({ type: "quote" }), 1);
  const b = await createDocument(d1, "ana", base({ type: "quote" }), 2);
  const c = await createDocument(d1, "ana", base(), 3);
  const d = await createDocument(d1, "bob", base({ contactId: "cb" }), 4);
  assert.deepEqual([a.body.number, b.body.number, c.body.number, d.body.number], [1, 2, 1, 1]);
  const list = (await listDocuments(d1, "ana")) as { type: string; number: number; totalMinor: number; contactName: string }[];
  assert.equal(list.length, 3);
  assert.equal(list.find((x) => x.type === "invoice")!.totalMinor, 2_500_000);
  assert.equal(list[0].contactName, "Cliente Uno");
});

test("another user's contact is rejected and nothing is created", async () => {
  const { db, d1 } = setup();
  const r = await createDocument(d1, "ana", base({ contactId: "cb" }), 1);
  assert.equal(r.status, 400);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM documents"), 0);
});

test("paying creates exactly one income, links it, and is idempotent", async () => {
  const { db, d1 } = setup();
  const { body } = await createDocument(d1, "ana", base(), 1);
  const id = body.id!;
  await setStatus(d1, "ana", id, "sent", 2);
  assert.equal((await payDocument(d1, "ana", id, "usd", "2026-10-20", 3)).status, 400, "currency mismatch");
  assert.equal((await payDocument(d1, "ana", id, "bob-ars", "2026-10-20", 3)).status, 400, "foreign account");
  const first = await payDocument(d1, "ana", id, "ars", "2026-10-20", 3);
  assert.equal(first.status, 200);
  const again = await payDocument(d1, "ana", id, "ars", "2026-10-21", 4);
  assert.equal(again.body.existed, true);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 1);
  const tx = db.prepare("SELECT * FROM financial_transactions").get() as Record<string, unknown>;
  assert.equal(tx.kind, "income"); assert.equal(tx.amount_minor, 2_500_000); assert.equal(tx.contact_id, "c1"); assert.equal(tx.occurred_at, "2026-10-20"); assert.equal(tx.category, "Factura");
  assert.match(String(tx.description), /F-0001 · Cliente Uno/);
  const doc = await getDocument(d1, "ana", id);
  assert.equal(doc!.status, "paid"); assert.equal(doc!.transactionId, tx.id);
  assert.equal((await updateDocument(d1, "ana", id, base(), 5)).status, 409, "paid is closed");
  assert.equal((await setStatus(d1, "ana", id, "void", 5)).status, 409);
  assert.equal((await deleteDocument(d1, "ana", id)).status, 409);
});

test("a race on payment leaves a single income (second writer rolls back)", async () => {
  const { db, d1 } = setup();
  const { body } = await createDocument(d1, "ana", base(), 1);
  const id = body.id!;
  // Simulate the other writer winning between our read and our write.
  const realPrepare = d1.prepare.bind(d1);
  let injected = false;
  const racing = { prepare(sql: string) {
    if (!injected && sql.startsWith("INSERT INTO financial_transactions")) {
      injected = true;
      db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES ('other','ana','ars','income',2500000,'Factura','2026-10-20',1)").run();
      db.prepare("UPDATE documents SET status='paid', transaction_id='other', paid_at='2026-10-20' WHERE id=?").run(id);
    }
    return realPrepare(sql);
  } };
  const r = await payDocument(racing, "ana", id, "ars", "2026-10-20", 2);
  assert.equal(r.body.existed, true);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM financial_transactions"), 1);
});

test("void invoices cannot be paid; quotes cannot be paid; drafts can be deleted", async () => {
  const { d1 } = setup();
  const inv = (await createDocument(d1, "ana", base(), 1)).body.id!;
  const quote = (await createDocument(d1, "ana", base({ type: "quote" }), 1)).body.id!;
  assert.equal((await payDocument(d1, "ana", quote, "ars", "2026-10-20", 2)).status, 400);
  await setStatus(d1, "ana", inv, "void", 2);
  assert.equal((await payDocument(d1, "ana", inv, "ars", "2026-10-20", 3)).status, 409);
  assert.equal((await setStatus(d1, "ana", inv, "sent", 4)).status, 409);
  assert.equal((await deleteDocument(d1, "ana", inv)).status, 409, "void is not a draft");
  assert.equal((await deleteDocument(d1, "ana", quote)).status, 200);
  assert.equal((await getDocument(d1, "ana", quote)), null);
  assert.equal((await deleteDocument(d1, "bob", inv)).status, 409);
});

test("quote -> invoice copies items, is idempotent and keeps the quote", async () => {
  const { db, d1 } = setup();
  const q = (await createDocument(d1, "ana", base({ type: "quote", notes: "Nota", items: [{ description: "A", quantityMilli: 1000, unitPriceMinor: 100 }, { description: "B", quantityMilli: 2000, unitPriceMinor: 250 }] }), 1)).body.id!;
  const r1 = await convertQuote(d1, "ana", q, "2026-10-30", 2);
  assert.equal(r1.status, 201); assert.equal(r1.body.number, 1);
  const r2 = await convertQuote(d1, "ana", q, "2026-10-31", 3);
  assert.equal(r2.body.existed, true); assert.equal(r2.body.id, r1.body.id);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM documents WHERE doc_type='invoice'"), 1);
  const inv = await getDocument(d1, "ana", r1.body.id!);
  assert.equal(inv!.status, "draft"); assert.equal(inv!.dueDate, "2026-11-14"); assert.equal(inv!.issueDate, "2026-10-30");
  assert.equal(inv!.notes, "Nota"); assert.equal(inv!.contactId, "c1"); assert.deepEqual(inv!.items.map((i) => i.description), ["A", "B"]);
  assert.equal(inv!.totalMinor, 600);
  assert.equal((await getDocument(d1, "ana", q))!.invoiceId, inv!.id);
  assert.equal((await convertQuote(d1, "bob", q, "2026-10-30", 4)).status, 404);
  assert.equal((await convertQuote(d1, "ana", inv!.id, "2026-10-30", 4)).status, 400);
});

test("update replaces items and keeps the number", async () => {
  const { d1 } = setup();
  const { body } = await createDocument(d1, "ana", base(), 1);
  const r = await updateDocument(d1, "ana", body.id!, base({ currency: "USD", notes: "n", items: [{ description: "Z", quantityMilli: 1000, unitPriceMinor: 99 }] }), 2);
  assert.equal(r.status, 200);
  const d = await getDocument(d1, "ana", body.id!);
  assert.equal(d!.number, 1); assert.equal(d!.currency, "USD"); assert.equal(d!.items.length, 1); assert.equal(d!.totalMinor, 99);
  assert.equal((await updateDocument(d1, "ana", body.id!, base({ type: "quote" }), 3)).status, 400);
  assert.equal((await updateDocument(d1, "bob", body.id!, base({ contactId: "cb" }), 3)).status, 404);
});

test("billable hours: import candidates, linking, no double billing", async () => {
  const { db, d1 } = setup();
  seedTask(db, "t1", "ana", "c1", "Landing"); seedTask(db, "t2", "ana", null, "Otra"); seedTask(db, "tb", "bob", "cb", "De Bob");
  seedEntry(db, "e1", "ana", "t1", { hours: 1.5, rate: 2_000_000 });
  seedEntry(db, "e2", "ana", "t1", { billable: 0 });
  seedEntry(db, "e3", "ana", "t1", { currency: "USD" });
  seedEntry(db, "e4", "ana", "t2");
  seedEntry(db, "e5", "ana", "t1", { rate: 0 });
  seedEntry(db, "eb", "bob", "tb");
  const cands = await importableTimeEntries(d1, "ana", "c1", "ARS", null);
  assert.deepEqual(cands.map((c) => c.id), ["e1"]);
  assert.equal(cands[0].item.quantityMilli, 1500); assert.equal(cands[0].item.unitPriceMinor, 2_000_000); assert.match(cands[0].item.description, /^Landing · \d{4}-\d{2}-\d{2}$/);
  const doc = await createDocument(d1, "ana", base({ items: [cands[0].item] }), 1);
  assert.equal(doc.status, 201);
  assert.equal((await getDocument(d1, "ana", doc.body.id!))!.items[0].timeEntryId, "e1");
  assert.deepEqual(await importableTimeEntries(d1, "ana", "c1", "ARS", null), [], "already invoiced");
  assert.equal((await importableTimeEntries(d1, "ana", "c1", "ARS", doc.body.id!)).length, 1, "its own hours stay available while editing it");
  const dup = await createDocument(d1, "ana", base({ items: [cands[0].item] }), 2);
  assert.equal(dup.status, 400);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM documents"), 1);
  assert.equal((await createDocument(d1, "ana", base({ items: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 1, timeEntryId: "eb" }] }), 3)).status, 400, "foreign entry");
  assert.equal((await createDocument(d1, "ana", base({ items: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 1, timeEntryId: "e2" }] }), 3)).status, 400, "not billable");
  assert.equal((await createDocument(d1, "ana", base({ currency: "USD", items: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 1, timeEntryId: "e1" }] }), 3)).status, 400);
  // Editing the same document keeps its own links; removing the item frees the hours.
  assert.equal((await updateDocument(d1, "ana", doc.body.id!, base({ items: [cands[0].item] }), 4)).status, 200);
  await updateDocument(d1, "ana", doc.body.id!, base(), 5);
  assert.equal((await importableTimeEntries(d1, "ana", "c1", "ARS", null)).length, 1);
  // Deleting a draft frees them too.
  const d2 = await createDocument(d1, "ana", base({ items: [cands[0].item] }), 6);
  assert.equal((await importableTimeEntries(d1, "ana", "c1", "ARS", null)).length, 0);
  await deleteDocument(d1, "ana", d2.body.id!);
  assert.equal((await importableTimeEntries(d1, "ana", "c1", "ARS", null)).length, 1);
});

test("itemFromTimeEntry rounds hours to two decimals and uses Buenos Aires day", () => {
  const it = itemFromTimeEntry({ id: "e", taskTitle: "Tarea", description: null, startedAt: Date.UTC(2026, 9, 30, 1, 0), durationMs: 5_400_000 + 10_000, hourlyRateMinor: 100 });
  assert.equal(it.description, "Tarea · 2026-10-29");
  assert.equal(it.quantityMilli, 1500);
});

test("overdueInvoices only returns sent, past-due invoices", async () => {
  const { d1 } = setup();
  const mk = async (due: string, status: "draft" | "sent" | "void") => { const id = (await createDocument(d1, "ana", base({ dueDate: due }), 1)).body.id!; await setStatus(d1, "ana", id, status, 2); return id; };
  const late = await mk("2026-10-01", "sent");
  await mk("2026-10-01", "draft"); await mk("2026-10-01", "void"); await mk("2026-11-01", "sent");
  const paid = await mk("2026-10-02", "sent"); await payDocument(d1, "ana", paid, "ars", "2026-10-10", 3);
  const rows = await overdueInvoices(d1, "ana", "2026-10-30");
  assert.deepEqual(rows.map((r) => r.id), [late]);
});
