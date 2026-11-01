import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importDek } from "../lib/crypto/dek.ts";
import { SCAN_AI_WARNING } from "../lib/e2e-server.ts";
import { closeEngine, shouldUseLocalEngine, startEngine, type Engine } from "../lib/e2e/engine.ts";
import { AI_DISABLED_MESSAGE, SCAN_LIMIT_MESSAGE } from "../lib/ai-quota.ts";
import { todayInBuenosAires } from "../lib/recurring.ts";
import { openDb, user } from "./db-helper.mts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";

const wasm = readFileSync(new URL("../public/vendor/sql-wasm.wasm", import.meta.url));
const BASE = "http://t.local";

const routes = {
  list: await import("../app/api/e2e/records/route.ts"),
  record: await import("../app/api/e2e/records/[collection]/[id]/route.ts"),
  counter: await import("../app/api/e2e/counter/route.ts"),
  keys: await import("../app/api/e2e/keys/route.ts"),
  scan: await import("../app/api/e2e/scan-ai/route.ts"),
  data: await import("../app/api/data/[resource]/route.ts"),
  dataId: await import("../app/api/data/[resource]/[id]/route.ts"),
  totals: await import("../app/api/finance/totals/route.ts"),
  documents: await import("../app/api/documents/route.ts"),
  documentId: await import("../app/api/documents/[id]/route.ts"),
  recurring: await import("../app/api/recurring/route.ts"),
};

let scanCalls = 0;

function passwordWrap() {
  return { v: 1, type: "password", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), m: 65536, t: 3, p: 1, argonSalt: "r".repeat(22) };
}

async function serverFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/e2e/scan-ai") scanCalls += 1;
  let mod: Record<string, (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>> | null = null;
  let params: Record<string, string> = {};
  if (path === "/api/e2e/records") mod = routes.list;
  else if (path === "/api/e2e/counter") mod = routes.counter;
  else if (path === "/api/e2e/keys") mod = routes.keys;
  else if (path === "/api/e2e/scan-ai") mod = routes.scan;
  else {
    const match = path.match(/^\/api\/e2e\/records\/([^/]+)\/([^/]+)$/);
    if (match) {
      mod = routes.record;
      params = { collection: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
    }
  }
  if (!mod) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  const contentType = request.headers.get("content-type") ?? "";
  const opts: { form?: FormData; text?: string; params: Record<string, string>; headers: Record<string, string> } = { params, headers };
  if (contentType.includes("multipart/form-data")) {
    opts.form = await request.formData();
    // The rebuilt Request must mint its own boundary. Keeping the original header makes the file unreadable.
    delete headers["content-type"];
  }
  else if (request.method !== "GET" && request.method !== "HEAD") opts.text = await request.text();
  const result = await call(mod, request.method, request.url, opts);
  return new Response(result.text, { status: result.status, headers: result.headers });
}

async function enable(userId: string, db: ReturnType<typeof openDb>["db"], d1: unknown) {
  user(db, userId);
  asUser(userId);
  setEnv(d1);
  const created = await call(routes.keys, "POST", BASE + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "pw" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
}

async function dekOf(): Promise<CryptoKey> {
  return importDek(crypto.getRandomValues(new Uint8Array(32)));
}

async function boot(userId: string, dek: CryptoKey, extra: { events?: EventTarget; fetch?: typeof fetch; installFetch?: boolean } = {}): Promise<Engine> {
  asUser(userId);
  return startEngine({
    userId,
    dek,
    wasm,
    fetch: extra.fetch ?? serverFetch,
    name: userId,
    email: userId + "@test.local",
    baseUrl: BASE,
    events: extra.events,
    installFetch: extra.installFetch,
  });
}

async function api(engine: Engine, method: string, path: string, json?: unknown) {
  const response = await engine.handle(BASE + path, {
    method,
    headers: json !== undefined ? { "content-type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await response.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* bytes or plain text */ } }
  return { status: response.status, body, text };
}

function idOf(body: unknown): string {
  const id = (body as { id?: string }).id;
  assert.equal(typeof id, "string");
  return id as string;
}

const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const out = new Uint8Array(pngHeader.length + body.length);
  out.set(pngHeader);
  out.set(body, pngHeader.length);
  return out;
}

test("two devices round-trip, conflict, and delete through the real routes", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    const userId = "device-user";
    await enable(userId, db, d1);
    const dek = await dekOf();
    const a = await boot(userId, dek);
    const engines = [a];
    try {
      const contact = await api(a, "POST", "/api/data/contacts", { name: "Ada Lovelace", email: "ada@example.com", phone: "+54 11 555", notes: "primera", avatarData: "data:image/png;base64,iVBORw0KGgo=", avatarSource: "custom" });
      assert.equal(contact.status, 201, JSON.stringify(contact.body));
      const contactId = idOf(contact.body);
      const project = await api(a, "POST", "/api/data/projects", { name: "Motor analítico", description: "Notas del proyecto" });
      assert.equal(project.status, 201, JSON.stringify(project.body));
      const projectId = idOf(project.body);
      const task = await api(a, "POST", "/api/data/tasks", { title: "Revisar cifras", projectId, contactId });
      assert.equal(task.status, 201, JSON.stringify(task.body));
      const taskId = idOf(task.body);
      const keep = await api(a, "POST", "/api/data/contacts", { name: "Grace Hopper", notes: "no tocar" });
      const keepId = idOf(keep.body);
      const account = await api(a, "POST", "/api/data/accounts", { name: "Caja", currency: "ARS", openingBalanceMinor: 0 });
      assert.equal(account.status, 201, JSON.stringify(account.body));
      const accountId = idOf(account.body);
      const tx = await api(a, "POST", "/api/data/transactions", { accountId, contactId, amountMinor: 250000, category: "Servicios", kind: "income", occurredAt: "2026-10-02", description: "Seña" });
      assert.equal(tx.status, 201, JSON.stringify(tx.body));
      const quote = await api(a, "POST", "/api/documents", { type: "quote", contactId, issueDate: "2026-10-01", dueDate: "2026-12-01", currency: "ARS", notes: "Presupuesto del motor", items: [{ description: "Análisis", quantityMilli: 1000, unitPriceMinor: 180000 }] });
      assert.equal(quote.status, 201, JSON.stringify(quote.body));
      const quoteId = idOf(quote.body);
      const converted = await api(a, "PATCH", "/api/documents/" + quoteId, { action: "convert" });
      assert.equal(converted.status, 201, JSON.stringify(converted.body));
      const invoiceId = idOf(converted.body);
      const paid = await api(a, "PATCH", "/api/documents/" + invoiceId, { action: "pay", accountId, paidAt: "2026-10-20" });
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      const entry = await api(a, "POST", "/api/time-entries", { startedAt: 1_700_000_000_000, endedAt: 1_700_003_600_000, durationMs: 3_600_000, hourlyRateMinor: 10000, billable: true, description: "Horas de revisión", taskId });
      assert.equal(entry.status, 201, JSON.stringify(entry.body));
      const rule = await api(a, "POST", "/api/data/transactions", { accountId, amountMinor: 5000, category: "Alquiler", kind: "expense", occurredAt: "2026-10-31", description: "Alquiler", recurrence: "monthly", recurrenceEnd: "2026-10-31" });
      assert.equal(rule.status, 201, JSON.stringify(rule.body));
      await a.push();
      await a.idle();

      const b = await boot(userId, dek);
      engines.push(b);
      for (const path of ["/api/data/contacts", "/api/data/projects", "/api/data/tasks", "/api/data/accounts", "/api/data/transactions", "/api/finance/totals", "/api/documents", "/api/time-entries", "/api/recurring"]) {
        const left = await api(a, "GET", path);
        const right = await api(b, "GET", path);
        assert.equal(left.status, 200, path);
        assert.deepEqual(right.body, left.body, path);
      }
      const avatar = await b.handle(BASE + "/api/avatar/" + contactId);
      assert.equal(avatar.status, 200);
      assert.equal(avatar.headers.get("content-type"), "image/png");

      await api(a, "PATCH", "/api/data/contacts/" + contactId, { name: "Ada A", notes: "desde a" });
      await a.push();
      await api(b, "PATCH", "/api/data/contacts/" + contactId, { name: "Ada B", notes: "desde b" });
      await b.push();
      await a.pull();
      const contactsA = await api(a, "GET", "/api/data/contacts");
      const contactsB = await api(b, "GET", "/api/data/contacts");
      assert.deepEqual(contactsB.body, contactsA.body);
      const items = (contactsA.body as { items: { id: string; name: string; notes: string }[] }).items;
      assert.equal(items.find((row) => row.id === contactId)?.name, "Ada B");
      assert.equal(items.find((row) => row.id === contactId)?.notes, "desde b");
      assert.equal(items.find((row) => row.id === keepId)?.notes, "no tocar");
      const projects = await api(b, "GET", "/api/data/projects");
      assert.equal((projects.body as { items: { name: string }[] }).items.some((row) => row.name === "Motor analítico"), true);

      const removed = await api(a, "DELETE", "/api/data/tasks/" + taskId);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      await a.push();
      await b.pull();
      const tasks = await api(b, "GET", "/api/data/tasks");
      assert.equal((tasks.body as { items: { id: string }[] }).items.some((row) => row.id === taskId), false);
      const tasksA = await api(a, "GET", "/api/data/tasks");
      assert.deepEqual(tasks.body, tasksA.body);
    } finally {
      await closeEngine();
    }
  });
});

test("server mode and the local engine return the same business JSON", async () => {
  await locked(async () => {
    const legacy = openDb();
    const encrypted = openDb();
    const legacyId = "parity-server";
    const e2eId = "parity-e2e";
    user(legacy.db, legacyId);
    asUser(legacyId);
    setEnv(legacy.d1);
    async function legacyApi(method: string, path: string, params: Record<string, string>, json?: unknown) {
      const mod = path.startsWith("/api/finance/totals") ? routes.totals
        : path.startsWith("/api/documents") ? routes.documents
        : path.startsWith("/api/recurring") ? routes.recurring
        : routes.data;
      return call(mod, method, BASE + path, { params, json });
    }
    const contact = await legacyApi("POST", "/api/data/contacts", { resource: "contacts" }, { name: "Ada Lovelace", email: "ada@example.com", phone: "111", notes: "nota" });
    assert.equal(contact.status, 201, JSON.stringify(contact.body));
    const project = await legacyApi("POST", "/api/data/projects", { resource: "projects" }, { name: "Motor", description: "desc" });
    assert.equal(project.status, 201);
    const account = await legacyApi("POST", "/api/data/accounts", { resource: "accounts" }, { name: "Caja", currency: "ARS", openingBalanceMinor: 1000 });
    assert.equal(account.status, 201);
    const tx = await legacyApi("POST", "/api/data/transactions", { resource: "transactions" }, { accountId: idOf(account.body), contactId: idOf(contact.body), amountMinor: 12345678, category: "Servicios", kind: "income", occurredAt: "2026-09-15", description: "cobro" });
    assert.equal(tx.status, 201, JSON.stringify(tx.body));
    const doc = await legacyApi("POST", "/api/documents", {}, { type: "invoice", contactId: idOf(contact.body), issueDate: "2026-10-01", dueDate: "2026-12-01", currency: "ARS", notes: "factura", items: [{ description: "Trabajo", quantityMilli: 2000, unitPriceMinor: 5000 }] });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const legacyBodies = {
      totals: await legacyApi("GET", "/api/finance/totals", {}),
      transactions: await legacyApi("GET", "/api/data/transactions", { resource: "transactions" }),
      accounts: await legacyApi("GET", "/api/data/accounts", { resource: "accounts" }),
      contacts: await legacyApi("GET", "/api/data/contacts", { resource: "contacts" }),
      documents: await legacyApi("GET", "/api/documents", {}),
      recurring: await legacyApi("GET", "/api/recurring", {}),
    };

    await enable(e2eId, encrypted.db, encrypted.d1);
    const engine = await boot(e2eId, await dekOf());
    try {
      const contact2 = await api(engine, "POST", "/api/data/contacts", { name: "Ada Lovelace", email: "ada@example.com", phone: "111", notes: "nota" });
      assert.equal(contact2.status, 201, JSON.stringify(contact2.body));
      await api(engine, "POST", "/api/data/projects", { name: "Motor", description: "desc" });
      const account2 = await api(engine, "POST", "/api/data/accounts", { name: "Caja", currency: "ARS", openingBalanceMinor: 1000 });
      assert.equal(account2.status, 201, JSON.stringify(account2.body));
      const tx2 = await api(engine, "POST", "/api/data/transactions", { accountId: idOf(account2.body), contactId: idOf(contact2.body), amountMinor: 12345678, category: "Servicios", kind: "income", occurredAt: "2026-09-15", description: "cobro" });
      assert.equal(tx2.status, 201, JSON.stringify(tx2.body));
      const doc2 = await api(engine, "POST", "/api/documents", { type: "invoice", contactId: idOf(contact2.body), issueDate: "2026-10-01", dueDate: "2026-12-01", currency: "ARS", notes: "factura", items: [{ description: "Trabajo", quantityMilli: 2000, unitPriceMinor: 5000 }] });
      assert.equal(doc2.status, 201, JSON.stringify(doc2.body));
      const engineBodies = {
        totals: await api(engine, "GET", "/api/finance/totals"),
        transactions: await api(engine, "GET", "/api/data/transactions"),
        accounts: await api(engine, "GET", "/api/data/accounts"),
        contacts: await api(engine, "GET", "/api/data/contacts"),
        documents: await api(engine, "GET", "/api/documents"),
        recurring: await api(engine, "GET", "/api/recurring"),
      };
      for (const key of Object.keys(legacyBodies) as (keyof typeof legacyBodies)[]) {
        assert.equal(engineBodies[key].status, 200, key);
        assert.deepEqual(normalize(engineBodies[key].body, e2eId), normalize(legacyBodies[key].body, legacyId), key);
      }
    } finally {
      await engine.close();
    }
  });
});

test("the server stores ciphertext only", async () => {
  await locked(async () => {
    const marker = "E2E-MARKER-7f3a9c2e-serpix-plaintext";
    const { db, d1 } = openDb();
    const userId = "cipher-user";
    await enable(userId, db, d1);
    const engine = await boot(userId, await dekOf());
    try {
      const contact = await api(engine, "POST", "/api/data/contacts", { name: marker + "-name", email: marker + "@example.com", phone: marker + "-phone", notes: marker + "-notes" });
      assert.equal(contact.status, 201, JSON.stringify(contact.body));
      await api(engine, "POST", "/api/data/projects", { name: marker + "-project", description: marker + "-description" });
      const account = await api(engine, "POST", "/api/data/accounts", { name: marker + "-account", currency: "ARS" });
      assert.equal(account.status, 201, JSON.stringify(account.body));
      const tx = await api(engine, "POST", "/api/data/transactions", { accountId: idOf(account.body), amountMinor: 12345678, category: marker + "-category", kind: "expense", occurredAt: "2026-08-01", description: marker + "-movement" });
      assert.equal(tx.status, 201, JSON.stringify(tx.body));
      const doc = await api(engine, "POST", "/api/documents", { type: "quote", contactId: idOf(contact.body), issueDate: "2026-08-02", dueDate: "2026-12-01", currency: "ARS", notes: marker + "-doc", items: [{ description: marker + "-item", quantityMilli: 1000, unitPriceMinor: 12345678 }] });
      assert.equal(doc.status, 201, JSON.stringify(doc.body));
      const bytes = pngBytes(marker + "-ticket");
      const form = new FormData();
      form.set("file", new File([bytes], "ticket.png", { type: "image/png" }));
      const scan = await engine.handle(new Request(BASE + "/api/receipts/scan", { method: "POST", body: form }));
      assert.equal(scan.status, 201, await scan.text());
      await engine.push();
      await engine.idle();

      const columns = db.prepare("PRAGMA table_info(records)").all() as { name: string }[];
      assert.deepEqual(columns.map((column) => column.name).sort(), ["blob", "collection", "created_at", "deleted", "doc_due_date", "doc_number", "doc_status", "doc_type", "id", "seq", "updated_at", "user_id", "version"].sort());
      const dirtyDocs = db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection != 'documents' AND (doc_type IS NOT NULL OR doc_number IS NOT NULL OR doc_status IS NOT NULL OR doc_due_date IS NOT NULL)").get(userId) as { n: number };
      assert.equal(Number(dirtyDocs.n), 0);
      const docs = db.prepare("SELECT doc_type, doc_number, doc_status FROM records WHERE user_id = ? AND collection = 'documents' AND deleted = 0").all(userId) as { doc_type: string; doc_number: number; doc_status: string }[];
      assert.equal(docs.length, 1);
      assert.equal(docs[0].doc_type, "quote");
      assert.equal(docs[0].doc_status, "draft");
      assert.equal(typeof docs[0].doc_number, "number");
      const files = db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = 'receipt_files' AND deleted = 0").get(userId) as { n: number };
      assert.equal(Number(files.n), 1);
      for (const table of ["contacts", "projects", "tasks", "financial_accounts", "financial_transactions", "activities", "activity_contacts", "time_entries", "timer_state", "documents", "document_items", "document_time_entries", "receipts", "recurring_rules"]) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number };
        assert.equal(Number(count.n), 0, table);
      }
      const dump = dumpDatabase(db);
      const amount = "12345678";
      const forms = [marker, Buffer.from(marker).toString("base64"), Buffer.from(marker).toString("base64url"), Buffer.from(marker).toString("hex"), amount, Buffer.from(amount).toString("base64"), Buffer.from(amount).toString("hex")];
      for (const form of forms) assert.equal(dump.includes(form), false, form);
    } finally {
      await engine.close();
    }
  });
});

test("recurring ids and document numbers converge, and AI scan stays opt-in", async () => {
  await locked(async () => {
    scanCalls = 0;
    const { db, d1 } = openDb();
    const userId = "rules-user";
    await enable(userId, db, d1);
    const dek = await dekOf();
    const a = await boot(userId, dek);
    const b = await boot(userId, dek);
    try {
      const account = await api(a, "POST", "/api/data/accounts", { name: "Banco", currency: "ARS" });
      const accountId = idOf(account.body);
      const made = await api(a, "POST", "/api/data/transactions", { accountId, amountMinor: 9000, category: "Alquiler", kind: "expense", occurredAt: "2026-09-01", description: "Alquiler", recurrence: "monthly", recurrenceEnd: "2026-10-31" });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      await a.push();
      await b.pull();
      const rule = await a.d1.prepare("SELECT id FROM recurring_rules").first<{ id: string }>();
      assert.ok(rule);
      const periodId = `rr.${rule.id}.2026-10-01`;
      const generated = await a.d1.prepare("SELECT id FROM financial_transactions WHERE recurring_period = '2026-10-01'").first<{ id: string }>();
      assert.equal(generated?.id, periodId);
      await a.d1.prepare("DELETE FROM financial_transactions WHERE recurring_period = '2026-10-01'").run();
      await b.d1.prepare("DELETE FROM financial_transactions WHERE recurring_period = '2026-10-01'").run();
      // Catch-up skips ended rules. Past the end date the first run marks the rule ended, so rewind status too.
      await a.d1.prepare("UPDATE recurring_rules SET generated_through = '2026-09-01', status = 'active'").run();
      await b.d1.prepare("UPDATE recurring_rules SET generated_through = '2026-09-01', status = 'active'").run();
      assert.equal((await api(a, "GET", "/api/recurring")).status, 200);
      assert.equal((await api(b, "GET", "/api/recurring")).status, 200);
      const againA = await a.d1.prepare("SELECT id FROM financial_transactions WHERE recurring_period = '2026-10-01'").first<{ id: string }>();
      const againB = await b.d1.prepare("SELECT id FROM financial_transactions WHERE recurring_period = '2026-10-01'").first<{ id: string }>();
      assert.equal(againA?.id, periodId);
      assert.equal(againB?.id, periodId);
      await a.push();
      await b.push();
      await a.pull();
      await b.pull();
      const live = db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = 'transactions' AND deleted = 0").get(userId) as { n: number };
      assert.equal(Number(live.n), 2);

      const first = await api(a, "POST", "/api/documents", { type: "quote", issueDate: "2026-10-01", dueDate: "2026-12-01", currency: "ARS", items: [{ description: "Uno", quantityMilli: 1000, unitPriceMinor: 100 }] });
      const second = await api(b, "POST", "/api/documents", { type: "quote", issueDate: "2026-10-02", dueDate: "2026-12-01", currency: "ARS", items: [{ description: "Dos", quantityMilli: 1000, unitPriceMinor: 200 }] });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      const numbers = [Number((first.body as { number: number }).number), Number((second.body as { number: number }).number)].sort((x, y) => x - y);
      assert.deepEqual(numbers, [1, 2]);
      await a.push();
      await b.push();
      const docs = db.prepare("SELECT doc_number FROM records WHERE user_id = ? AND collection = 'documents' AND deleted = 0").all(userId) as { doc_number: number }[];
      assert.deepEqual(docs.map((row) => Number(row.doc_number)).sort((x, y) => x - y), [1, 2]);

      const before = scanCalls;
      const plain = new FormData();
      plain.set("file", new File([pngBytes("ticket-sin-ia")], "a.png", { type: "image/png" }));
      const stored = await a.handle(new Request(BASE + "/api/receipts/scan", { method: "POST", body: plain }));
      const storedBody = await stored.json() as { receiptId?: string; ok?: boolean; warning?: string };
      assert.equal(stored.status, 201);
      assert.equal(storedBody.ok, false);
      assert.equal(storedBody.warning, undefined);
      assert.equal(scanCalls, before);

      const flagged = new FormData();
      flagged.set("file", new File([pngBytes("ticket-flag")], "b.png", { type: "image/png" }));
      flagged.set("ai", "1");
      const disabled = await a.handle(new Request(BASE + "/api/receipts/scan", { method: "POST", body: flagged }));
      const disabledBody = await disabled.json() as { aiStatus?: string; message?: string; warning?: string; receiptId?: string };
      assert.equal(scanCalls, before + 1);
      assert.equal(disabledBody.aiStatus, "disabled");
      assert.equal(disabledBody.message, AI_DISABLED_MESSAGE);
      assert.equal(disabledBody.warning, SCAN_AI_WARNING);
      assert.equal(typeof disabledBody.receiptId, "string");

      db.prepare("UPDATE user SET ai_receipts_enabled = 1 WHERE id = ?").run(userId);
      db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, ?, 'receipt_scans', 10)").run(todayInBuenosAires(), userId);
      const limited = new FormData();
      limited.set("file", new File([pngBytes("ticket-quota")], "c.png", { type: "image/png" }));
      limited.set("ai", "1");
      const quota = await a.handle(new Request(BASE + "/api/receipts/scan", { method: "POST", body: limited }));
      const quotaBody = await quota.json() as { error?: string; warning?: string; receiptId?: string };
      assert.equal(quota.status, 429);
      assert.equal(quotaBody.error, SCAN_LIMIT_MESSAGE);
      assert.equal(quotaBody.warning, SCAN_AI_WARNING);
      assert.equal(typeof quotaBody.receiptId, "string");
      assert.equal(scanCalls, before + 2);
    } finally {
      await closeEngine();
    }
  });
});

test("admin server mode is unchanged and the local engine stays off", async () => {
  await locked(async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    const { db, d1 } = openDb();
    user(db, "admin");
    db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run("admin");
    asUser("admin", "admin");
    setEnv(d1);
    try {
      const contact = await call(routes.data, "POST", BASE + "/api/data/contacts", { params: { resource: "contacts" }, json: { name: "Contacto admin" } });
      assert.equal(contact.status, 201, JSON.stringify(contact.body));
      const totals = await call(routes.totals, "GET", BASE + "/api/finance/totals");
      assert.equal(totals.status, 200);
      const list = await call(routes.data, "GET", BASE + "/api/data/contacts", { params: { resource: "contacts" } });
      assert.equal(list.status, 200);
      assert.equal((list.body as { items: { name: string }[] }).items[0].name, "Contacto admin");
      const keys = await call(routes.keys, "POST", BASE + "/api/e2e/keys", { json: { type: "password", wrap: passwordWrap(), id: "no-admin" } });
      assert.equal(keys.status, 403);
      const records = await call(routes.list, "GET", BASE + "/api/e2e/records?since=0");
      assert.equal(records.status, 403);
      assert.equal(shouldUseLocalEngine({ role: "admin", encryptionMode: "e2e" }), false);
      assert.equal(shouldUseLocalEngine({ role: "admin", encryptionMode: "server" }), false);
      assert.equal(shouldUseLocalEngine({ role: "user", encryptionMode: "server" }), false);
      assert.equal(shouldUseLocalEngine({ role: "user", encryptionMode: "e2e" }), true);
      assert.equal(globalThis.fetch, original);
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String(input));
        return original(input, init);
      }) as typeof fetch;
      assert.equal(seen.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("a dropped network keeps the row dirty and the online event retries", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    const userId = "offline-user";
    await enable(userId, db, d1);
    let down = false;
    const events = new EventTarget();
    const engine = await boot(userId, await dekOf(), {
      events,
      fetch: (input, init) => {
        if (down) return Promise.reject(new Error("offline"));
        return serverFetch(input, init);
      },
    });
    try {
      const contact = await api(engine, "POST", "/api/data/contacts", { name: "Antes" });
      assert.equal(contact.status, 201, JSON.stringify(contact.body));
      await engine.push();
      down = true;
      const patched = await api(engine, "PATCH", "/api/data/contacts/" + idOf(contact.body), { name: "Después", notes: "local" });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      await engine.push();
      assert.equal(engine.status(), "offline");
      const pending = db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = 'contacts'").get(userId) as { n: number };
      assert.equal(Number(pending.n), 1);
      down = false;
      events.dispatchEvent(new Event("online"));
      await engine.idle();
      await engine.push();
      await engine.idle();
      assert.equal(engine.status(), "idle");
      const names = db.prepare("SELECT deleted FROM records WHERE user_id = ? AND collection = 'contacts'").all(userId) as { deleted: number }[];
      assert.equal(names.length, 1);
      assert.equal(Number(names[0].deleted), 0);
    } finally {
      await engine.close();
    }
  });
});

function normalize(value: unknown, userId: string): unknown {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (item === userId || item === userId + "@test.local") return "USER";
      if (uuid.test(item)) return "UUID";
      return item;
    }
    if (typeof item === "number") return item >= 1e12 ? "TS" : item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) out[key] = walk((item as Record<string, unknown>)[key]);
      return out;
    }
    return item ?? null;
  };
  return walk(value);
}

function dumpDatabase(db: ReturnType<typeof openDb>["db"]): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const parts: string[] = [];
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all() as { name: string }[];
    const rows = db.prepare(`SELECT * FROM ${JSON.stringify(table.name)}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const column of columns) parts.push(cellText(row[column.name]));
    }
  }
  return parts.join("\n");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let extra = "";
  const pattern = /"c":"([A-Za-z0-9_-]+)"/g;
  for (const match of text.matchAll(pattern)) {
    extra += "\n" + Buffer.from(match[1], "base64url").toString("utf8");
  }
  return text + extra;
}
