import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { resetEncryptionModeCache } from "../lib/mailtox-link.ts";
import {
  createContact,
  createEvent,
  createTask,
  listContacts,
  listEvents,
  listInquiries,
  listTasks,
  searchContacts,
  searchEvents,
  searchInquiries,
  searchTasks,
  type RpcResult,
} from "../lib/mcp-rpc.ts";
import { openDb } from "./db-shim.mts";

const OWNER = "admin@owner.test";
const root = fileURLToPath(new URL("..", import.meta.url));
const ENCRYPTED = { ok: false as const, error: { code: "encrypted_account" as const, message: "encrypted account, not readable server-side" } };
const NO_OWNER = { ok: false as const, error: { code: "no_owner" as const, message: "no owner" } };

function person(db: DatabaseSync, id: string, role: "admin" | "user", approval: "approved" | "pending" | "rejected", email = id + "@test.local") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, approval);
}

function setup(role: "admin" | "user" = "admin", approval: "approved" | "pending" | "rejected" = "approved", email: string | null = OWNER) {
  resetEncryptionModeCache();
  const opened = openDb();
  if (email !== null) person(opened.db, "owner", role, approval, email);
  return opened;
}

function contact(db: DatabaseSync, id: string, userId: string, name: string, extra: { company?: string | null; email?: string | null; phone?: string | null; notes?: string | null; updatedAt?: number } = {}) {
  const at = extra.updatedAt ?? 1;
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, userId, "person", name, extra.company ?? null, extra.email ?? null, extra.phone ?? null, extra.notes ?? null, at, at);
}

function task(db: DatabaseSync, id: string, userId: string, title: string, extra: { description?: string | null; status?: string; priority?: string; due?: string | null; contactId?: string | null; updatedAt?: number } = {}) {
  const at = extra.updatedAt ?? 1;
  db.prepare("INSERT INTO tasks (id,user_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, userId, extra.contactId ?? null, title, extra.description ?? null, extra.status ?? "todo", extra.priority ?? "normal", extra.due ?? null, at, at);
}

function activity(db: DatabaseSync, id: string, userId: string, kind: "event" | "note", title: string, occurredAt: string, extra: { body?: string | null; createdAt?: number } = {}) {
  const at = extra.createdAt ?? 1;
  db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, kind, title, extra.body ?? null, occurredAt, at, at);
}

function inquiry(db: DatabaseSync, id: string, userId: string, name: string, extra: { email?: string; message?: string; status?: string; source?: string; createdAt?: number; readAt?: number | null } = {}) {
  db.prepare("INSERT INTO inquiries (id,user_id,source,name,email,message,status,created_at,read_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, userId, extra.source ?? "portfolio", name, extra.email ?? "a@b.co", extra.message ?? "hola", extra.status ?? "new", extra.createdAt ?? 1, extra.readAt ?? null);
}

function count(db: DatabaseSync, table: string) {
  return (db.prepare("SELECT COUNT(*) AS n FROM " + table).get() as { n: number }).n;
}

function counts(db: DatabaseSync) {
  return {
    contacts: count(db, "contacts"),
    tasks: count(db, "tasks"),
    activities: count(db, "activities"),
    links: count(db, "activity_contacts"),
    inquiries: count(db, "inquiries"),
    records: count(db, "records"),
    keys: count(db, "user_keys"),
  };
}

function errorOf(result: RpcResult<unknown>) {
  assert.equal(result.ok, false);
  if (!result.ok) return result.error;
  throw new Error("missing error");
}

test("owner gating fails closed before validation", async () => {
  const user = setup("user", "approved");
  contact(user.db, "secret", "owner", "Secreto");
  const before = counts(user.db);
  assert.deepEqual(await listContacts(user.d1, OWNER, { limit: 0 }), NO_OWNER);
  assert.deepEqual(await searchContacts(user.d1, OWNER, { query: "Secreto" }), NO_OWNER);
  assert.deepEqual(await createContact(user.d1, OWNER, { name: "Nuevo" }), NO_OWNER);
  assert.deepEqual(await createTask(user.d1, OWNER, { title: "T" }), NO_OWNER);
  assert.deepEqual(await createEvent(user.d1, OWNER, { title: "E", occurredAt: "2026-01-01" }), NO_OWNER);
  assert.deepEqual(await listEvents(user.d1, OWNER, { from: "2026-01-01", to: "2026-01-02" }), NO_OWNER);
  assert.deepEqual(counts(user.db), before);

  const pending = setup("admin", "pending");
  assert.deepEqual(await listTasks(pending.d1, OWNER, {}), NO_OWNER);
  assert.deepEqual(await searchInquiries(pending.d1, OWNER, { query: "a" }), NO_OWNER);
  const rejected = setup("admin", "rejected");
  assert.deepEqual(await listInquiries(rejected.d1, OWNER, {}), NO_OWNER);
  const missing = setup("admin", "approved", null);
  assert.deepEqual(await listContacts(missing.d1, OWNER, {}), NO_OWNER);
  assert.deepEqual(await createContact(missing.d1, "", { name: "X" }), NO_OWNER);
  assert.deepEqual(await listContacts(missing.d1, undefined, {}), NO_OWNER);
  assert.deepEqual(await listContacts(missing.d1, "   ", {}), NO_OWNER);

  const mixed = setup("admin", "approved", "Admin@Owner.Test");
  contact(mixed.db, "mine", "owner", "Mia");
  const page = await listContacts(mixed.d1, "  admin@owner.test  ", {});
  assert.equal(page.ok, true);
  if (page.ok) assert.deepEqual(page.data.items.map((item) => item.id), ["mine"]);
});

test("e2e and any non-server mode return encrypted_account and write nothing", async () => {
  const { db, d1 } = setup();
  person(db, "other", "user", "approved", "other@test.local");
  contact(db, "keep", "owner", "Original", { email: "ana@ex.test" });
  const before = counts(db);
  for (const mode of ["e2e", "weird"]) {
    db.prepare("UPDATE user SET encryption_mode=? WHERE id='owner'").run(mode);
    resetEncryptionModeCache();
    assert.deepEqual(await listContacts(d1, OWNER, {}), ENCRYPTED, mode);
    assert.deepEqual(await searchTasks(d1, OWNER, { query: "a" }), ENCRYPTED, mode);
    assert.deepEqual(await listEvents(d1, OWNER, { from: "2026-01-01", to: "2026-01-02" }), ENCRYPTED, mode);
    assert.deepEqual(await createContact(d1, OWNER, { name: "Nuevo" }), ENCRYPTED, mode);
    assert.deepEqual(await createTask(d1, OWNER, { title: "Tarea" }), ENCRYPTED, mode);
    assert.deepEqual(await createEvent(d1, OWNER, { title: "Evt", occurredAt: "2026-08-01T10:00", contactIds: ["keep"] }), ENCRYPTED, mode);
    assert.deepEqual(await listContacts(d1, OWNER, { limit: 0 }), ENCRYPTED, mode);
    assert.deepEqual(counts(db), before, mode);
  }
  db.prepare("UPDATE user SET encryption_mode='server' WHERE id='owner'").run();
  resetEncryptionModeCache();
  const page = await listContacts(d1, OWNER, {});
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.data.items.length, 1);
  const created = await createContact(d1, OWNER, { name: "Visible" });
  assert.equal(created.ok, true);
  assert.equal(count(db, "contacts"), 2);
});

test("pagination caps a page at 50", async () => {
  const { db, d1 } = setup();
  person(db, "other", "user", "approved", "other@test.local");
  contact(db, "other-1", "other", "AAA-secret");
  for (let i = 0; i < 51; i++) contact(db, "c" + String(i).padStart(2, "0"), "owner", "N" + String(i).padStart(2, "0"), { updatedAt: i + 1 });
  const first = await listContacts(d1, OWNER, { limit: 50, offset: 0 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.data.items.length, 50);
  assert.equal(first.data.nextOffset, 50);
  assert.deepEqual(first.data.items.map((item) => item.name), Array.from({ length: 50 }, (_, i) => "N" + String(i).padStart(2, "0")));
  assert.equal(first.data.items.some((item) => item.id === "other-1" || item.name === "AAA-secret"), false);
  const second = await listContacts(d1, OWNER, { limit: 50, offset: first.data.nextOffset ?? 0 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.data.items.map((item) => item.name), ["N50"]);
  assert.equal(second.data.nextOffset, null);
  const defaults = await listContacts(d1, OWNER, {});
  assert.equal(defaults.ok, true);
  if (defaults.ok) {
    assert.equal(defaults.data.items.length, 20);
    assert.equal(defaults.data.nextOffset, 20);
  }
  assert.deepEqual(errorOf(await listContacts(d1, OWNER, { limit: 51 })), { code: "invalid", message: "invalid limit" });
  assert.deepEqual(errorOf(await listContacts(d1, OWNER, { limit: 0 })), { code: "invalid", message: "invalid limit" });
  assert.deepEqual(errorOf(await listContacts(d1, OWNER, { limit: 1.5 })), { code: "invalid", message: "invalid limit" });
  assert.deepEqual(errorOf(await listContacts(d1, OWNER, { offset: -1 })), { code: "invalid", message: "invalid offset" });
  assert.deepEqual(errorOf(await listTasks(d1, OWNER, { limit: 100 })), { code: "invalid", message: "invalid limit" });
});

test("search treats % and _ as literals and stays inside the owner", async () => {
  const { db, d1 } = setup();
  person(db, "other", "user", "approved", "other@test.local");
  contact(db, "wild", "owner", "100%_ok", { company: "Acme", email: "ana@ex.test", phone: "+5411", notes: "nota a\\b" });
  contact(db, "under", "owner", "a_b");
  contact(db, "plain", "owner", "plain", { notes: "O'Brien" });
  contact(db, "other-wild", "other", "100%_ok", { email: "other@ex.test", notes: "nota a\\b" });
  task(db, "tw", "owner", "100%_done", { description: "detalle", status: "todo" });
  task(db, "td", "owner", "otra", { description: "100%_done", status: "done" });
  task(db, "to", "other", "100%_done", { description: "detalle" });
  activity(db, "ew", "owner", "event", "Reunion", "2026-06-01T12:00", { body: "cuerpo 100%_note" });
  activity(db, "en", "owner", "note", "100%_note", "2026-06-01T12:00");
  activity(db, "eo", "other", "event", "100%_note", "2026-06-01T12:00");
  inquiry(db, "iw", "owner", "Lia", { message: "pide 100%_msg", status: "new", createdAt: 2 });
  inquiry(db, "ir", "owner", "Leo", { message: "leido", status: "read", email: "100%_msg@ex.test", createdAt: 1 });
  inquiry(db, "io", "other", "Lia", { message: "pide 100%_msg" });

  const percent = await searchContacts(d1, OWNER, { query: "%" });
  assert.equal(percent.ok, true);
  if (percent.ok) assert.deepEqual(percent.data.items.map((item) => item.id), ["wild"]);
  const underscore = await searchContacts(d1, OWNER, { query: "_" });
  assert.equal(underscore.ok, true);
  if (underscore.ok) assert.deepEqual(underscore.data.items.map((item) => item.id).sort(), ["under", "wild"]);
  const exact = await searchContacts(d1, OWNER, { query: "100%_ok" });
  assert.equal(exact.ok, true);
  if (exact.ok) assert.deepEqual(exact.data.items.map((item) => item.id), ["wild"]);
  const notWildcard = await searchContacts(d1, OWNER, { query: "a%b" });
  assert.equal(notWildcard.ok, true);
  if (notWildcard.ok) assert.deepEqual(notWildcard.data.items, []);
  const slash = await searchContacts(d1, OWNER, { query: "a\\b" });
  assert.equal(slash.ok, true);
  if (slash.ok) assert.deepEqual(slash.data.items.map((item) => item.id), ["wild"]);
  for (const query of ["acme", "ANA@ex.test", "+5411", "O'Brien"]) {
    const found = await searchContacts(d1, OWNER, { query });
    assert.equal(found.ok, true, query);
    if (found.ok) assert.equal(found.data.items.length, 1, query);
  }
  assert.deepEqual(errorOf(await searchContacts(d1, OWNER, { query: "" })), { code: "invalid", message: "invalid query" });
  assert.deepEqual(errorOf(await searchContacts(d1, OWNER, { query: "x".repeat(201) })), { code: "invalid", message: "invalid query" });
  assert.deepEqual(errorOf(await searchContacts(d1, OWNER, {})), { code: "invalid", message: "invalid query" });

  const tasksFound = await searchTasks(d1, OWNER, { query: "100%_done" });
  assert.equal(tasksFound.ok, true);
  if (tasksFound.ok) assert.deepEqual(tasksFound.data.items.map((item) => item.id).sort(), ["td", "tw"]);
  const todoOnly = await searchTasks(d1, OWNER, { query: "100%_done", status: "todo" });
  assert.equal(todoOnly.ok, true);
  if (todoOnly.ok) assert.deepEqual(todoOnly.data.items.map((item) => item.id), ["tw"]);
  const eventsFound = await searchEvents(d1, OWNER, { query: "100%_note" });
  assert.equal(eventsFound.ok, true);
  if (eventsFound.ok) {
    assert.deepEqual(eventsFound.data.items.map((item) => item.id), ["ew"]);
    assert.equal(eventsFound.data.items[0]!.occurredAt, "2026-06-01T12:00");
  }
  const inquiriesFound = await searchInquiries(d1, OWNER, { query: "100%_msg" });
  assert.equal(inquiriesFound.ok, true);
  if (inquiriesFound.ok) assert.deepEqual(inquiriesFound.data.items.map((item) => item.id).sort(), ["ir", "iw"]);
  const fresh = await searchInquiries(d1, OWNER, { query: "100%_msg", status: "new" });
  assert.equal(fresh.ok, true);
  if (fresh.ok) assert.deepEqual(fresh.data.items.map((item) => item.id), ["iw"]);
  assert.deepEqual(errorOf(await searchTasks(d1, OWNER, { query: "a", status: "later" })), { code: "invalid", message: "invalid status" });
});

test("lists stay inside the owner and events filter by an inclusive 366-day range", async () => {
  const { db, d1 } = setup();
  person(db, "other", "user", "approved", "other@test.local");
  contact(db, "mine", "owner", "Mia");
  contact(db, "theirs", "other", "Ajena");
  task(db, "t1", "owner", "Llamar", { status: "todo", due: "2026-03-02", contactId: "mine", updatedAt: 2 });
  task(db, "t2", "owner", "Hecho", { status: "done", due: "2026-03-01", updatedAt: 3 });
  task(db, "t3", "other", "Llamar", { status: "todo" });
  activity(db, "e-early", "owner", "event", "Temprano", "2026-03-01T09:00", { createdAt: 1 });
  activity(db, "e-late", "owner", "event", "Tarde", "2026-03-01 18:30", { createdAt: 2 });
  activity(db, "e-mid", "owner", "event", "Medio", "2026-03-15T12:00:00.000Z", { createdAt: 3 });
  activity(db, "e-day", "owner", "event", "Dia", "2026-04-01", { createdAt: 4 });
  activity(db, "note", "owner", "note", "Medio", "2026-03-15T12:00", { createdAt: 5 });
  activity(db, "e-other", "other", "event", "Medio", "2026-03-15T12:00", { createdAt: 3 });
  db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").run("e-mid", "mine", "owner");
  db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").run("e-mid", "theirs", "owner");
  db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").run("e-other", "theirs", "other");
  inquiry(db, "i-new", "owner", "Nueva", { status: "new", createdAt: 5, message: "hola" });
  inquiry(db, "i-read", "owner", "Leida", { status: "read", createdAt: 4, readAt: 9, source: "portfolio" });
  inquiry(db, "i-other", "other", "Nueva", { status: "new", createdAt: 8 });

  const tasks = await listTasks(d1, OWNER, { status: "todo" });
  assert.equal(tasks.ok, true);
  if (tasks.ok) {
    assert.deepEqual(tasks.data.items.map((item) => item.id), ["t1"]);
    assert.equal(tasks.data.items[0]!.contactId, "mine");
    assert.equal(tasks.data.items[0]!.dueDate, "2026-03-02");
  }
  const allTasks = await listTasks(d1, OWNER, {});
  assert.equal(allTasks.ok, true);
  if (allTasks.ok) assert.deepEqual(allTasks.data.items.map((item) => item.id), ["t1", "t2"]);

  const day = await listEvents(d1, OWNER, { from: "2026-03-01", to: "2026-03-01" });
  assert.equal(day.ok, true);
  if (day.ok) {
    assert.deepEqual(day.data.items.map((item) => item.id), ["e-late", "e-early"]);
    assert.equal(day.data.items[0]!.occurredAt, "2026-03-01 18:30");
  }
  const afternoon = await listEvents(d1, OWNER, { from: "2026-03-01T12:00:00Z", to: "2026-03-01T23:59" });
  assert.equal(afternoon.ok, true);
  if (afternoon.ok) assert.deepEqual(afternoon.data.items.map((item) => item.id), ["e-late"]);
  const span = await listEvents(d1, OWNER, { from: "2026-03-01", to: "2026-04-01", limit: 10 });
  assert.equal(span.ok, true);
  if (span.ok) {
    assert.deepEqual(span.data.items.map((item) => item.id), ["e-day", "e-mid", "e-late", "e-early"]);
    assert.deepEqual(span.data.items.find((item) => item.id === "e-mid")!.contactIds, ["mine"]);
    assert.equal(span.data.items.some((item) => item.id === "note" || item.id === "e-other"), false);
  }
  const page = await listEvents(d1, OWNER, { from: "2026-03-01", to: "2026-03-01", limit: 1 });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.deepEqual(page.data.items.map((item) => item.id), ["e-late"]);
    assert.equal(page.data.nextOffset, 1);
  }
  assert.equal((await listEvents(d1, OWNER, { from: "2024-01-01", to: "2025-01-01" })).ok, true);
  assert.deepEqual(errorOf(await listEvents(d1, OWNER, { from: "2024-01-01", to: "2025-01-02" })), { code: "invalid", message: "invalid date range" });
  assert.deepEqual(errorOf(await listEvents(d1, OWNER, { from: "2026-05-02", to: "2026-05-01" })), { code: "invalid", message: "invalid date range" });
  assert.deepEqual(errorOf(await listEvents(d1, OWNER, { from: "2026-05-01T18:00", to: "2026-05-01T09:00" })), { code: "invalid", message: "invalid date range" });
  assert.deepEqual(errorOf(await listEvents(d1, OWNER, { to: "2026-05-01" })), { code: "invalid", message: "invalid date range" });
  assert.deepEqual(errorOf(await listEvents(d1, OWNER, { from: "2026-02-31", to: "2026-03-01" })), { code: "invalid", message: "invalid date range" });
  assert.deepEqual(errorOf(await searchEvents(d1, OWNER, { query: "Medio", from: "2024-01-01", to: "2025-01-02" })), { code: "invalid", message: "invalid date range" });
  const found = await searchEvents(d1, OWNER, { query: "Medio", from: "2026-03-15T12:00:00Z", to: "2026-03-15T12:00:00Z" });
  assert.equal(found.ok, true);
  if (found.ok) assert.deepEqual(found.data.items.map((item) => item.id), ["e-mid"]);
  const outside = await searchEvents(d1, OWNER, { query: "Medio", from: "2026-04-01", to: "2026-04-02" });
  assert.equal(outside.ok, true);
  if (outside.ok) assert.deepEqual(outside.data.items, []);

  const inquiries = await listInquiries(d1, OWNER, { status: "new" });
  assert.equal(inquiries.ok, true);
  if (inquiries.ok) {
    assert.deepEqual(inquiries.data.items.map((item) => item.id), ["i-new"]);
    assert.equal(inquiries.data.items[0]!.readAt, null);
  }
  const read = await listInquiries(d1, OWNER, {});
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.deepEqual(read.data.items.map((item) => item.id), ["i-new", "i-read"]);
    assert.equal(read.data.items[1]!.readAt, 9);
    assert.equal(read.data.items[1]!.source, "portfolio");
  }
  assert.deepEqual(errorOf(await listInquiries(d1, OWNER, { status: "closed" })), { code: "invalid", message: "invalid status" });
});

test("creates validate like the app, then insert only the owner's rows", async () => {
  const { db, d1 } = setup();
  person(db, "other", "admin", "approved", "other@test.local");
  contact(db, "mine", "owner", "Mia");
  contact(db, "theirs", "other", "Ajena");
  const before = counts(db);

  for (const input of [{}, { name: "   " }, { name: "x".repeat(161) }, { name: "Ana", kind: "robot" }, { name: "Ana", email: "e".repeat(255) }, { name: "Ana", notes: "n".repeat(5001) }, { name: 12 }]) {
    assert.equal((await createContact(d1, OWNER, input)).ok, false, JSON.stringify(input));
    assert.equal(errorOf(await createContact(d1, OWNER, input)).code, "invalid");
  }
  for (const input of [{}, { title: " " }, { title: "t".repeat(201) }, { title: "T", dueDate: "2025-02-29" }, { title: "T", dueDate: "ayer" }, { title: "T", status: "later" }, { title: "T", priority: "max" }, { title: "T", contactId: "theirs" }, { title: "T", contactId: "missing" }, { title: "T", contactId: "nope' OR '1'='1" }]) {
    assert.equal(errorOf(await createTask(d1, OWNER, input)).code, "invalid", JSON.stringify(input));
  }
  for (const input of [{ title: "E" }, { title: " ", occurredAt: "2026-08-01" }, { occurredAt: "2026-08-01" }, { title: "E", occurredAt: "ayer" }, { title: "E", occurredAt: "2026-02-31T10:00" }, { title: "E", occurredAt: "2026-08-01T25:00" }, { title: "E".repeat(201), occurredAt: "2026-08-01" }, { title: "E", occurredAt: "2026-08-01", body: "b".repeat(30001) }, { title: "E", occurredAt: "2026-08-01", contactIds: ["theirs"] }, { title: "E", occurredAt: "2026-08-01", contactIds: ["mine", "theirs"] }, { title: "E", occurredAt: "2026-08-01", contactIds: "mine" }]) {
    assert.equal(errorOf(await createEvent(d1, OWNER, input)).code, "invalid", JSON.stringify(input));
  }
  assert.deepEqual(counts(db), before);

  const createdContact = await createContact(d1, OWNER, { name: "  Ana  ", kind: "company", email: "  Ana@X.com  ", phone: " +54 ", company: "  Acme  ", notes: "  hi  " });
  assert.equal(createdContact.ok, true);
  if (!createdContact.ok) return;
  assert.match(createdContact.data.id, /^[0-9a-f-]{36}$/i);
  const contactRow = db.prepare("SELECT user_id, kind, name, company_name, email, phone, notes, is_potential, role, relations, updated_at FROM contacts WHERE id=?").get(createdContact.data.id) as { user_id: string; kind: string; name: string; company_name: string; email: string; phone: string; notes: string; is_potential: number; role: string; relations: string; updated_at: number };
  assert.equal(contactRow.user_id, "owner");
  assert.equal(contactRow.kind, "company");
  assert.equal(contactRow.name, "Ana");
  assert.equal(contactRow.company_name, "Acme");
  assert.equal(contactRow.email, "Ana@X.com");
  assert.equal(contactRow.phone, "+54");
  assert.equal(contactRow.notes, "hi");
  assert.equal(contactRow.is_potential, 0);
  assert.equal(contactRow.role, "potential");
  assert.equal(contactRow.relations, "{}");
  assert.equal(contactRow.updated_at, createdContact.data.updatedAt);
  assert.equal(createdContact.data.company, "Acme");

  const createdTask = await createTask(d1, OWNER, { title: "  Llamar  ", description: "  texto  ", priority: "high", dueDate: "2026-07-01", contactId: "mine" });
  assert.equal(createdTask.ok, true);
  if (!createdTask.ok) return;
  assert.equal(createdTask.data.status, "todo");
  assert.equal(createdTask.data.priority, "high");
  assert.equal(createdTask.data.dueDate, "2026-07-01");
  assert.equal(createdTask.data.contactId, "mine");
  assert.equal(createdTask.data.title, "Llamar");
  assert.equal(createdTask.data.description, "texto");
  const taskRow = db.prepare("SELECT user_id, project_id, contact_id, title, status, priority, due_date FROM tasks WHERE id=?").get(createdTask.data.id) as { user_id: string; project_id: string | null; contact_id: string; title: string; status: string; priority: string; due_date: string };
  assert.deepEqual({ ...taskRow }, { user_id: "owner", project_id: null, contact_id: "mine", title: "Llamar", status: "todo", priority: "high", due_date: "2026-07-01" });

  const createdEvent = await createEvent(d1, OWNER, { title: "  Reunion  ", occurredAt: "  2026-07-02T16:45  ", body: "  notas  ", contactIds: ["mine", createdContact.data.id, "mine"] });
  assert.equal(createdEvent.ok, true);
  if (!createdEvent.ok) return;
  assert.equal(createdEvent.data.occurredAt, "2026-07-02T16:45");
  assert.deepEqual(createdEvent.data.contactIds, ["mine", createdContact.data.id]);
  assert.equal(createdEvent.data.body, "notas");
  const eventRow = db.prepare("SELECT user_id, kind, title, body, occurred_at FROM activities WHERE id=?").get(createdEvent.data.id) as { user_id: string; kind: string; title: string; body: string; occurred_at: string };
  assert.deepEqual({ ...eventRow }, { user_id: "owner", kind: "event", title: "Reunion", body: "notas", occurred_at: "2026-07-02T16:45" });
  const links = db.prepare("SELECT contact_id, user_id FROM activity_contacts WHERE activity_id=? ORDER BY contact_id").all(createdEvent.data.id) as Array<{ contact_id: string; user_id: string }>;
  assert.deepEqual(links.map((row) => row.user_id), ["owner", "owner"]);
  assert.deepEqual(links.map((row) => row.contact_id).sort(), [createdContact.data.id, "mine"].sort());

  const spaced = await createEvent(d1, OWNER, { title: "Manana", occurredAt: "2026-07-03 09:15" });
  assert.equal(spaced.ok, true);
  if (!spaced.ok) return;
  assert.equal(spaced.data.occurredAt, "2026-07-03 09:15");
  assert.deepEqual(spaced.data.contactIds, []);
  const listed = await listEvents(d1, OWNER, { from: "2026-07-03", to: "2026-07-03" });
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.data.items.map((item) => item.id), [spaced.data.id]);
  const minute = await listEvents(d1, OWNER, { from: "2026-07-02T16:45:00Z", to: "2026-07-02T16:45:00Z" });
  assert.equal(minute.ok, true);
  if (minute.ok) assert.deepEqual(minute.data.items.map((item) => item.id), [createdEvent.data.id]);

  const otherRows = db.prepare("SELECT id FROM contacts WHERE user_id='other' ORDER BY id").all() as Array<{ id: string }>;
  assert.deepEqual(otherRows.map((row) => row.id), ["theirs"]);
  assert.equal(count(db, "records"), 0);
  assert.equal(count(db, "user_keys"), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id='other'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM activities WHERE user_id='other'").get() as { n: number }).n, 0);
});

test("internal errors do not leak SQL", async () => {
  const boom = {
    prepare() {
      throw new Error("SELECT secret FROM user_keys WHERE encryption_mode");
    },
  };
  const result = await listContacts(boom, OWNER, {});
  assert.deepEqual(result, { ok: false, error: { code: "internal", message: "internal error" } });
  const blob = JSON.stringify(result);
  assert.equal(blob.includes("SELECT"), false);
  assert.equal(blob.includes("user_keys"), false);
  assert.equal(blob.includes("encryption_mode"), false);
});

test("McpRpc is a named WorkerEntrypoint and the logic module stays pure", () => {
  const worker = readFileSync(join(root, "worker.ts"), "utf8");
  assert.match(worker, /export class McpRpc extends WorkerEntrypoint\b/);
  const start = worker.indexOf("export class McpRpc");
  const end = worker.indexOf("const worker = {");
  const body = worker.slice(start, end);
  for (const name of ["listContacts", "searchContacts", "createContact", "listTasks", "searchTasks", "createTask", "listEvents", "searchEvents", "createEvent", "listInquiries", "searchInquiries"]) {
    assert.match(body, new RegExp("\\b" + name + "\\("));
  }
  assert.equal(body.includes("SELECT"), false);
  assert.equal(body.includes("fetch("), false);
  const workerObj = worker.slice(worker.indexOf("const worker = {"), worker.indexOf("export default"));
  assert.equal(workerObj.includes("McpRpc"), false);
  assert.equal(worker.slice(worker.indexOf("export default")).includes("McpRpc"), false);
  const source = readFileSync(join(root, "lib/mcp-rpc.ts"), "utf8");
  assert.equal(source.includes("next/"), false);
  assert.equal(source.includes("cloudflare:"), false);
  assert.equal(source.includes("user_keys"), false);
  assert.equal(/\brecords\b/.test(source), false);
  const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"MCP_OWNER_EMAIL"\s*:\s*"lucianoolivabianco@gmail.com"/);
});
