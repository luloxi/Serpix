import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { openDb, seedUser, seedContact } from "./db-shim.mts";
import { createDocument, setStatus, type DocInput } from "../lib/documents.ts";
import { notifyOverdueInvoices, overdueMessage } from "../lib/documents-push.ts";

const b64u = (b: Buffer) => b.toString("base64url");
const vapidKey = createECDH("prime256v1"); vapidKey.generateKeys();
const cfg = { publicKey: b64u(vapidKey.getPublicKey()), privateKey: b64u(vapidKey.getPrivateKey()), subject: "mailto:a@b.co" };
const doc = (due: string, price = 100_00): DocInput => ({ type: "invoice", contactId: "c1", issueDate: "2026-09-01", dueDate: due, currency: "ARS", notes: null, items: [{ description: "x", quantityMilli: 1000, unitPriceMinor: price }] });

function setup(withSub = true) {
  const { db, d1 } = openDb();
  seedUser(db, "ana"); seedContact(db, "c1", "ana", "Cliente Uno");
  if (withSub) { const ua = createECDH("prime256v1"); ua.generateKeys(); db.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES ('s1','ana','https://push.example/abc',?,?,1)").run(b64u(ua.getPublicKey()), b64u(randomBytes(16))); }
  return { db, d1 };
}
async function sentInvoice(d1: ReturnType<typeof openDb>["d1"], due: string, price?: number) {
  const id = (await createDocument(d1, "ana", doc(due, price), 1)).body.id!;
  await setStatus(d1, "ana", id, "sent", 2);
  return id;
}

test("overdueMessage groups totals per currency", () => {
  const one = overdueMessage([{ id: "1", number: 1, currency: "ARS", totalMinor: 150_000, contactName: "Acme" }]);
  assert.match(one.title, /Factura vencida sin cobrar · Acme/);
  const many = overdueMessage([{ id: "1", number: 1, currency: "ARS", totalMinor: 100, contactName: null }, { id: "2", number: 2, currency: "USD", totalMinor: 5000, contactName: null }, { id: "3", number: 3, currency: "ARS", totalMinor: 100, contactName: null }]);
  assert.equal(many.title, "3 facturas vencidas sin cobrar");
  assert.match(many.body, /^\$ 2,00 \+ US\$ 50,00$/);
});

test("one push per user for newly overdue invoices, never repeated", async () => {
  const { db, d1 } = setup();
  await sentInvoice(d1, "2026-10-01"); await sentInvoice(d1, "2026-10-05"); await sentInvoice(d1, "2026-12-01");
  const calls: string[] = [];
  const doFetch = (async (url: string) => { calls.push(url); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
  const r = await notifyOverdueInvoices(d1, "2026-10-30", cfg, doFetch);
  assert.deepEqual(r, { users: 1, invoices: 2, pushes: 1 });
  assert.equal(calls.length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents WHERE overdue_notified_on='2026-10-30'").get() as { n: number }).n, 2);
  const again = await notifyOverdueInvoices(d1, "2026-10-31", cfg, doFetch);
  assert.deepEqual(again, { users: 0, invoices: 0, pushes: 0 });
  assert.equal(calls.length, 1, "no second push for the same invoices");
  await sentInvoice(d1, "2026-10-20"); // a new one becomes overdue later
  const third = await notifyOverdueInvoices(d1, "2026-11-02", cfg, doFetch);
  assert.equal(third.invoices, 1); assert.equal(calls.length, 2);
});

test("failed delivery is retried next run; dead subscriptions are removed", async () => {
  const { db, d1 } = setup();
  await sentInvoice(d1, "2026-10-01");
  const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
  assert.equal((await notifyOverdueInvoices(d1, "2026-10-30", cfg, failing)).invoices, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents WHERE overdue_notified_on IS NULL AND status='sent'").get() as { n: number }).n, 1);
  const gone = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
  await notifyOverdueInvoices(d1, "2026-10-31", cfg, gone);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n, 0);
  // With no subscription left there is nothing to retry: it is marked so it does not loop forever.
  const never = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
  assert.equal((await notifyOverdueInvoices(d1, "2026-11-01", cfg, never)).invoices, 1);
});

test("paid or voided invoices are never announced", async () => {
  const { db, d1 } = setup();
  const id = await sentInvoice(d1, "2026-10-01");
  await setStatus(d1, "ana", id, "void", 3);
  const never = (async () => { throw new Error("no push expected"); }) as unknown as typeof fetch;
  assert.deepEqual(await notifyOverdueInvoices(d1, "2026-10-30", cfg, never), { users: 0, invoices: 0, pushes: 0 });
  assert.ok(db);
});
