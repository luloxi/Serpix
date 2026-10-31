import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import {
  CONTACT_PAGE_SIZE,
  emailMatchExpr,
  listContactsWithEmail,
  matchKey,
  normalizeEmail,
  resetEncryptionModeCache,
  upsertContactByEmail,
} from "../lib/mailtox-link.ts";
import { openDb } from "./db-shim.mts";

const OWNER = "admin@owner.test";
const root = fileURLToPath(new URL("..", import.meta.url));

function person(db: DatabaseSync, id: string, role: "admin" | "user", approval: "approved" | "pending" | "rejected", email = id + "@test.local") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, approval);
}

function contact(db: DatabaseSync, id: string, userId: string, name: string, email: string | null, updatedAt: number, extra: { phone?: string | null; company?: string | null } = {}) {
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,is_potential,role,relations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,'potential','{}',?,?)").run(id, userId, "person", name, extra.company ?? null, email, extra.phone ?? null, null, updatedAt, updatedAt);
}

function setup(role: "admin" | "user" = "admin", approval: "approved" | "pending" | "rejected" = "approved", email = OWNER) {
  resetEncryptionModeCache();
  const opened = openDb();
  person(opened.db, "owner", role, approval, email);
  return opened;
}

function rows(db: DatabaseSync) {
  return db.prepare("SELECT id, user_id, name, company_name, email, phone, notes, updated_at FROM contacts ORDER BY id").all() as Array<{ id: string; user_id: string; name: string; company_name: string | null; email: string | null; phone: string | null; notes: string | null; updated_at: number }>;
}

function sqlKey(db: DatabaseSync, email: string) {
  return (db.prepare(`SELECT ${emailMatchExpr("e")} AS k FROM (SELECT ? AS e)`).get(email) as { k: string }).k;
}

test("normalizeEmail and matchKey", () => {
  assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.equal(normalizeEmail("Ana Prueba <Ana@Example.TEST>"), "ana@example.test");
  assert.equal(normalizeEmail('"Ana" <ana@example.test>'), "ana@example.test");
  assert.equal(normalizeEmail("\uFF41\uFF20ex\uFF0Etest"), "a@ex.test");
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail("   "), null);
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("a@@b.com"), null);
  assert.equal(normalizeEmail("a @b.com"), null);
  assert.equal(normalizeEmail("@b.com"), null);
  assert.equal(normalizeEmail("a@"), null);
  assert.equal(normalizeEmail("Name <not-an-email>"), null);
  assert.equal(normalizeEmail("foo bar@x.com"), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(12), null);
  assert.equal(normalizeEmail("a@" + "b".repeat(250) + ".com"), null);

  assert.equal(matchKey("Foo+News@X.com"), matchKey("foo@x.com"));
  assert.equal(matchKey("A.B+Z@Gmail.com"), matchKey("ab@gmail.com"));
  assert.equal(matchKey("A.B+Z@GoogleMail.com"), matchKey("ab@gmail.com"));
  assert.equal(matchKey("a.b@gmail.com"), "ab@gmail.com");
  assert.equal(matchKey("f.o.o@gmail.com"), "foo@gmail.com");
  assert.notEqual(matchKey("a.b@example.com"), matchKey("ab@example.com"));
  assert.equal(matchKey("a.b+z@example.com"), matchKey("a.b@example.com"));
  assert.notEqual(matchKey("foo+news@x.com"), matchKey("foo@y.com"));
  assert.equal(matchKey("foo@bar.gmail.com"), "foo@bar.gmail.com");
  assert.equal(matchKey("+tag@x.com"), null);
  assert.equal(matchKey("..@gmail.com"), null);
  assert.equal(matchKey("not-an-email"), null);
});

test("SQL match expression agrees with matchKey", () => {
  const { db } = openDb();
  const samples = [
    "Ana <Foo+Bar@Gmail.com>",
    "  A.B+Z@GoogleMail.com ",
    "a.b@example.com",
    "a.b+c@Example.com",
    "foo@x.com",
    "foo+news@x.com",
    '"Ana" <ana@example.test>',
    "f.o.o@gmail.com",
    "foo@bar.gmail.com",
  ];
  for (const raw of samples) {
    const key = matchKey(raw);
    assert.ok(key, raw);
    assert.equal(sqlKey(db, raw), key, raw);
  }
});

test("list pages the owner contacts that have an email", async () => {
  assert.equal(CONTACT_PAGE_SIZE, 200);
  const { db, d1 } = setup();
  person(db, "other", "user", "approved", "other@test.local");
  const total = 205;
  for (let i = 0; i < total; i++) {
    const id = "c" + String(i).padStart(3, "0");
    const updatedAt = 1000 + (i % 3);
    contact(db, id, "owner", "N" + i, i === 3 ? "Ana <Ana@Ex.TEST>" : `u${i}@ex.test`, updatedAt);
  }
  contact(db, "no-mail", "owner", "Sin mail", null, 5000);
  contact(db, "blank-mail", "owner", "Blanco", "   ", 5001);
  contact(db, "other-mail", "other", "Ajeno", "ajeno@ex.test", 1000);

  const first = await listContactsWithEmail(d1, OWNER, null);
  assert.equal(first.contacts.length, 200);
  assert.equal(first.nextCursor, first.contacts[199]!.updatedAt + ":" + first.contacts[199]!.id);
  assert.equal(first.contacts.some((c) => c.id === "other-mail" || c.id === "no-mail" || c.id === "blank-mail"), false);
  assert.deepEqual(Object.keys(first.contacts[0]!).sort(), ["email", "id", "name", "updatedAt"]);
  const display = first.contacts.find((c) => c.id === "c003");
  assert.ok(display);
  assert.equal(display.email, "ana@ex.test");
  assert.equal(display.name, "N3");

  const expected = rows(db)
    .filter((row) => row.user_id === "owner" && row.email && row.email.trim())
    .sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(first.contacts.map((c) => c.id), expected.slice(0, 200).map((row) => row.id));

  const second = await listContactsWithEmail(d1, OWNER, first.nextCursor);
  assert.equal(second.contacts.length, 5);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.contacts.map((c) => c.id), expected.slice(200).map((row) => row.id));
  const seen = new Set([...first.contacts, ...second.contacts].map((c) => c.id));
  assert.equal(seen.size, 205);

  const again = await listContactsWithEmail(d1, OWNER, "");
  assert.equal(again.contacts[0]!.id, first.contacts[0]!.id);
  const afterLast = await listContactsWithEmail(d1, OWNER, second.contacts[4]!.updatedAt + ":" + second.contacts[4]!.id);
  assert.deepEqual(afterLast, { contacts: [], nextCursor: null });
});

test("upsert creates, dedupes, and leaves other users alone", async () => {
  const { db, d1 } = setup("admin", "approved", "Admin@Owner.Test");
  person(db, "other", "admin", "approved", "other@test.local");
  contact(db, "other-1", "other", "Ajeno", "foo@x.com", 10, { phone: "555", company: "Otra" });
  const beforeOther = rows(db);

  const created = await upsertContactByEmail(d1, "admin@owner.test", { email: "Ana <Foo@X.com>", name: "Ana", phone: " +54 11 ", company: "  Acme  " });
  assert.equal(created.status, "created");
  assert.ok(created.id);
  const row = db.prepare("SELECT * FROM contacts WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(row.user_id, "owner");
  assert.equal(row.kind, "person");
  assert.equal(row.name, "Ana");
  assert.equal(row.email, "foo@x.com");
  assert.equal(row.phone, "+54 11");
  assert.equal(row.company_name, "Acme");
  assert.equal(row.notes, null);
  assert.equal(row.is_potential, 0);
  assert.equal(row.role, "potential");
  assert.equal(row.relations, "{}");
  assert.equal(row.github_url, null);
  assert.deepEqual(rows(db).filter((item) => item.user_id === "other"), beforeOther);

  const again = await upsertContactByEmail(d1, "admin@owner.test", { email: "foo+news@x.com", name: "Otra", phone: "999", company: "Nueva" });
  assert.deepEqual(again, { status: "exists", id: created.id });
  const kept = db.prepare("SELECT name, email, phone, company_name FROM contacts WHERE id=?").get(created.id) as { name: string; email: string; phone: string; company_name: string };
  assert.equal(kept.name, "Ana");
  assert.equal(kept.email, "foo@x.com");
  assert.equal(kept.phone, "+54 11");
  assert.equal(kept.company_name, "Acme");
  assert.equal(rows(db).filter((item) => item.user_id === "owner").length, 1);
  assert.deepEqual(rows(db).filter((item) => item.user_id === "other"), beforeOther);

  const gmail = await upsertContactByEmail(d1, OWNER, { email: "A.B+Z@Gmail.com", name: "Gmail" });
  assert.equal(gmail.status, "created");
  const dotted = await upsertContactByEmail(d1, OWNER, { email: "ab@googlemail.com", name: "Dots", phone: "1" });
  assert.deepEqual(dotted, { status: "exists", id: gmail.id });
  const gmailRow = db.prepare("SELECT email, name, phone FROM contacts WHERE id=?").get(gmail.id) as { email: string; name: string; phone: string | null };
  assert.equal(gmailRow.email, "a.b+z@gmail.com");
  assert.equal(gmailRow.name, "Gmail");
  assert.equal(gmailRow.phone, null);

  const dottedOther = await upsertContactByEmail(d1, OWNER, { email: "a.b@example.com", name: "Puntos" });
  const plainOther = await upsertContactByEmail(d1, OWNER, { email: "ab@example.com", name: "Sin puntos" });
  assert.equal(dottedOther.status, "created");
  assert.equal(plainOther.status, "created");
  assert.notEqual(dottedOther.id, plainOther.id);

  const named = await upsertContactByEmail(d1, OWNER, { email: "solo@ex.test" });
  assert.equal(named.status, "created");
  assert.equal((db.prepare("SELECT name FROM contacts WHERE id=?").get(named.id) as { name: string }).name, "solo");

  contact(db, "blank-name", "owner", "", "vacio@ex.test", 20, { phone: "111", company: "Vieja" });
  const filled = await upsertContactByEmail(d1, OWNER, { email: "vacio+tag@ex.test", name: "  Completo  ", phone: "222", company: "Nueva" });
  assert.deepEqual(filled, { status: "exists", id: "blank-name" });
  const filledRow = db.prepare("SELECT name, email, phone, company_name FROM contacts WHERE id='blank-name'").get() as { name: string; email: string; phone: string; company_name: string };
  assert.equal(filledRow.name, "Completo");
  assert.equal(filledRow.email, "vacio@ex.test");
  assert.equal(filledRow.phone, "111");
  assert.equal(filledRow.company_name, "Vieja");

  assert.deepEqual(rows(db).find((item) => item.id === "other-1"), beforeOther[0]);
});

test("concurrent upserts collapse to one contact", async () => {
  const { db, d1 } = setup();
  const [a, b] = await Promise.all([
    upsertContactByEmail(d1, OWNER, { email: "a.b+news@gmail.com", name: "A" }),
    upsertContactByEmail(d1, OWNER, { email: "ab@googlemail.com", name: "B" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ["created", "exists"]);
  assert.equal(a.id, b.id);
  assert.equal(rows(db).filter((row) => row.user_id === "owner").length, 1);

  const [c, d] = await Promise.all([
    upsertContactByEmail(d1, OWNER, { email: "foo+z@ex.test", name: "C" }),
    upsertContactByEmail(d1, OWNER, { email: "foo@ex.test", name: "D" }),
  ]);
  assert.deepEqual([c.status, d.status].sort(), ["created", "exists"]);
  assert.equal(c.id, d.id);
  assert.equal(rows(db).filter((row) => row.email === "foo@ex.test" || row.email === "foo+z@ex.test").length, 1);
});

test("no owner and non-admin write nothing", async () => {
  const missing = setup();
  const before = rows(missing.db);
  assert.deepEqual(await listContactsWithEmail(missing.d1, undefined), { contacts: [], nextCursor: null });
  assert.deepEqual(await upsertContactByEmail(missing.d1, undefined, { email: "a@b.co", name: "A" }), { status: "no_owner" });
  assert.deepEqual(await upsertContactByEmail(missing.d1, "nobody@owner.test", { email: "a@b.co", name: "A" }), { status: "no_owner" });
  assert.deepEqual(rows(missing.db), before);

  const user = setup("user", "approved");
  contact(user.db, "keep", "owner", "Original", "a@b.co", 5, { phone: "1" });
  const snap = rows(user.db);
  assert.deepEqual(await listContactsWithEmail(user.d1, OWNER), { contacts: [], nextCursor: null });
  assert.deepEqual(await upsertContactByEmail(user.d1, OWNER, { email: "a@b.co", name: "Nuevo", phone: "2" }), { status: "no_owner" });
  assert.deepEqual(rows(user.db), snap);

  const pending = setup("admin", "pending");
  assert.deepEqual(await upsertContactByEmail(pending.d1, OWNER, { email: "a@b.co" }), { status: "no_owner" });
  assert.equal(rows(pending.db).length, 0);
  const rejected = setup("admin", "rejected");
  assert.deepEqual(await listContactsWithEmail(rejected.d1, OWNER), { contacts: [], nextCursor: null });
  assert.equal(rows(rejected.db).length, 0);
});

test("invalid email writes nothing", async () => {
  const { db, d1 } = setup();
  contact(db, "keep", "owner", "Original", "ok@ex.test", 5);
  const before = rows(db);
  for (const email of ["", "   ", "nope", "a@b", "a@@b.com", "has space@x.com", "Name <bad>"]) {
    assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email, name: "X" }), { status: "invalid" }, email);
  }
  assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email: null as unknown as string }), { status: "invalid" });
  assert.deepEqual(rows(db), before);
});

test("e2e mode lists nothing and writes nothing", async () => {
  const { db, d1 } = setup();
  contact(db, "keep", "owner", "Original", "ana@ex.test", 5, { phone: "1", company: "Acme" });
  db.exec("ALTER TABLE user ADD COLUMN encryption_mode TEXT");
  db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='owner'").run();
  resetEncryptionModeCache();
  const before = rows(db);
  assert.deepEqual(await listContactsWithEmail(d1, OWNER), { contacts: [], nextCursor: null });
  assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email: "nueva@ex.test", name: "Nueva", phone: "9" }), { status: "skipped_e2e" });
  assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email: "nope" }), { status: "skipped_e2e" });
  assert.deepEqual(rows(db), before);

  db.prepare("UPDATE user SET encryption_mode='unknown' WHERE id='owner'").run();
  assert.deepEqual(await listContactsWithEmail(d1, OWNER), { contacts: [], nextCursor: null });
  assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email: "otra@ex.test", name: "Otra" }), { status: "skipped_e2e" });
  assert.deepEqual(rows(db), before);

  db.prepare("UPDATE user SET encryption_mode=NULL WHERE id='owner'").run();
  assert.deepEqual(await upsertContactByEmail(d1, OWNER, { email: "otra@ex.test" }), { status: "skipped_e2e" });
  assert.deepEqual(rows(db), before);
});

test("server encryption mode still syncs", async () => {
  const { db, d1 } = setup();
  db.exec("ALTER TABLE user ADD COLUMN encryption_mode TEXT");
  db.prepare("UPDATE user SET encryption_mode='server' WHERE id='owner'").run();
  resetEncryptionModeCache();
  contact(db, "keep", "owner", "Ana", "ana@ex.test", 5);
  const page = await listContactsWithEmail(d1, OWNER);
  assert.equal(page.contacts.length, 1);
  assert.equal(page.contacts[0]!.email, "ana@ex.test");
  const created = await upsertContactByEmail(d1, OWNER, { email: "nueva@ex.test", name: "Nueva" });
  assert.equal(created.status, "created");
  assert.equal(rows(db).length, 2);
});

test("sync does not log emails or names", async () => {
  const { d1 } = setup();
  const logs: unknown[][] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const push = (...args: unknown[]) => { logs.push(args); };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  try {
    await upsertContactByEmail(d1, OWNER, { email: "secreto@example.test", name: "Nombre Secreto" });
    await listContactsWithEmail(d1, OWNER);
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  const blob = JSON.stringify(logs);
  assert.equal(blob.includes("secreto@example.test"), false);
  assert.equal(blob.includes("Nombre Secreto"), false);
});

test("MailtoxLink is a named WorkerEntrypoint and app does not reference it", () => {
  const worker = readFileSync(join(root, "worker.ts"), "utf8");
  assert.match(worker, /export class MailtoxLink extends WorkerEntrypoint\b/);
  const start = worker.indexOf("export class MailtoxLink");
  const brace = worker.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < worker.length; i++) {
    if (worker[i] === "{") depth++;
    else if (worker[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = worker.slice(start, end + 1);
  assert.doesNotMatch(body, /\bfetch\b/);
  assert.equal(worker.split("\n").find((line) => line.startsWith("export default")), "export default worker;");
  const workerObj = worker.slice(worker.indexOf("const worker = {"), worker.indexOf("export default"));
  assert.equal(workerObj.includes("MailtoxLink"), false);
  assert.equal(worker.slice(worker.indexOf("export default")).includes("MailtoxLink"), false);

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else out.push(path);
    }
    return out;
  };
  for (const file of walk(join(root, "app"))) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("mailtox-link"), false, file);
    assert.equal(text.includes("MailtoxLink"), false, file);
  }

  const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"MAILTOX_LINK_OWNER_EMAIL"\s*:\s*"lucianoolivabianco@gmail.com"/);
});
