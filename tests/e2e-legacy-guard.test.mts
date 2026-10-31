import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openLocalDb } from "../lib/e2e/d1-local.ts";
import { addWrap, encryptionMode, LEGACY_DATA_ERROR, LEGACY_TABLES, listKeys } from "../lib/e2e-server.ts";
import { LOCAL_SCHEMA_SQL } from "../lib/e2e/schema.ts";
import { account, openDb, user } from "./db-helper.mts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";

const ENCRYPTED = "Cuenta cifrada: usá el modo cifrado de la app.";
const ABORT = /e2e_account_plaintext_write/;

type Db = DatabaseSync;

function passwordWrap(): Record<string, unknown> {
  return { v: 1, type: "password", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), m: 65536, t: 3, p: 1, argonSalt: "r".repeat(22) };
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get("u") as { n: number }).n;
}

function setMode(db: Db, mode: string) {
  db.prepare("UPDATE user SET encryption_mode = ? WHERE id = ?").run(mode, "u");
}

type Op = {
  table: (typeof LEGACY_TABLES)[number];
  setup?: (db: Db) => void;
  insert: (db: Db) => void;
  update: (db: Db) => void;
  read: (db: Db) => unknown;
  inserted: unknown;
  updated: unknown;
};

const ops: Op[] = [
  {
    table: "contacts",
    insert: (db) => db.prepare("INSERT INTO contacts (id,user_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("row", "u", "person", "Antes", 1, 1),
    update: (db) => db.prepare("UPDATE contacts SET name = ? WHERE id = ?").run("Despues", "row"),
    read: (db) => (db.prepare("SELECT name AS v FROM contacts WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Antes",
    updated: "Despues",
  },
  {
    table: "financial_transactions",
    setup: (db) => account(db, "caja", "u"),
    insert: (db) => db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run("row", "u", "caja", "expense", 100, "Cafe", "2026-10-01", 1),
    update: (db) => db.prepare("UPDATE financial_transactions SET category = ? WHERE id = ?").run("Te", "row"),
    read: (db) => (db.prepare("SELECT category AS v FROM financial_transactions WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Cafe",
    updated: "Te",
  },
  {
    table: "documents",
    insert: (db) => db.prepare("INSERT INTO documents (id,user_id,doc_type,number,issue_date,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("row", "u", "invoice", 1, "2026-10-01", "ARS", "draft", 1, 1),
    update: (db) => db.prepare("UPDATE documents SET notes = ? WHERE id = ?").run("nota", "row"),
    read: (db) => (db.prepare("SELECT notes AS v FROM documents WHERE id = 'row'").get() as { v: string | null } | undefined)?.v ?? null,
    inserted: null,
    updated: "nota",
  },
  {
    table: "time_entries",
    insert: (db) => db.prepare("INSERT INTO time_entries (id,user_id,started_at,ended_at,duration_ms,created_at) VALUES (?,?,?,?,?,?)").run("row", "u", 1, 2, 1, 1),
    update: (db) => db.prepare("UPDATE time_entries SET description = ? WHERE id = ?").run("horas", "row"),
    read: (db) => (db.prepare("SELECT description AS v FROM time_entries WHERE id = 'row'").get() as { v: string | null } | undefined)?.v ?? null,
    inserted: null,
    updated: "horas",
  },
  {
    table: "receipts",
    insert: (db) => db.prepare("INSERT INTO receipts (id,user_id,mime,size,data,created_at) VALUES (?,?,?,?,?,?)").run("row", "u", "image/png", 4, "AAAA", 1),
    update: (db) => db.prepare("UPDATE receipts SET read_ok = ? WHERE id = ?").run(1, "row"),
    read: (db) => (db.prepare("SELECT read_ok AS v FROM receipts WHERE id = 'row'").get() as { v: number } | undefined)?.v,
    inserted: 0,
    updated: 1,
  },
  {
    table: "recurring_rules",
    setup: (db) => account(db, "caja", "u"),
    insert: (db) => db.prepare("INSERT INTO recurring_rules (id,user_id,account_id,kind,amount_minor,category,frequency,anchor_date,from_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("row", "u", "caja", "expense", 500, "Alquiler", "monthly", "2020-01-01", "2020-01-01", 1, 1),
    update: (db) => db.prepare("UPDATE recurring_rules SET category = ? WHERE id = ?").run("Luz", "row"),
    read: (db) => (db.prepare("SELECT category AS v FROM recurring_rules WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Alquiler",
    updated: "Luz",
  },
  {
    table: "activities",
    insert: (db) => db.prepare("INSERT INTO activities (id,user_id,kind,title,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("row", "u", "note", "Nota", "2026-10-01T12:00:00.000Z", 1, 1),
    update: (db) => db.prepare("UPDATE activities SET title = ? WHERE id = ?").run("Otra", "row"),
    read: (db) => (db.prepare("SELECT title AS v FROM activities WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Nota",
    updated: "Otra",
  },
  {
    table: "projects",
    insert: (db) => db.prepare("INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run("row", "u", "Proyecto", 1, 1),
    update: (db) => db.prepare("UPDATE projects SET name = ? WHERE id = ?").run("Otro", "row"),
    read: (db) => (db.prepare("SELECT name AS v FROM projects WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Proyecto",
    updated: "Otro",
  },
  {
    table: "tasks",
    insert: (db) => db.prepare("INSERT INTO tasks (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run("row", "u", "Tarea", 1, 1),
    update: (db) => db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Otra", "row"),
    read: (db) => (db.prepare("SELECT title AS v FROM tasks WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Tarea",
    updated: "Otra",
  },
  {
    table: "financial_accounts",
    insert: (db) => db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("row", "u", "Caja", "ARS", 0, 1, 1),
    update: (db) => db.prepare("UPDATE financial_accounts SET name = ? WHERE id = ?").run("Banco", "row"),
    read: (db) => (db.prepare("SELECT name AS v FROM financial_accounts WHERE id = 'row'").get() as { v: string } | undefined)?.v,
    inserted: "Caja",
    updated: "Banco",
  },
  {
    table: "timer_state",
    insert: (db) => db.prepare("INSERT INTO timer_state (user_id,started_at,accumulated_ms,updated_at) VALUES (?,?,?,?)").run("u", 10, 0, 1),
    update: (db) => db.prepare("UPDATE timer_state SET accumulated_ms = ? WHERE user_id = ?").run(50, "u"),
    read: (db) => (db.prepare("SELECT accumulated_ms AS v FROM timer_state WHERE user_id = 'u'").get() as { v: number } | undefined)?.v,
    inserted: 0,
    updated: 50,
  },
];

test("plaintext INSERT and UPDATE abort unless encryption_mode is server", () => {
  assert.deepEqual(ops.map((op) => op.table).sort(), [...LEGACY_TABLES].sort());
  const { db: migrated } = openDb();
  const names = new Set((migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((row) => row.name));
  for (const table of LEGACY_TABLES) {
    assert.ok(names.has(table + "_e2e_guard_insert"), table);
    assert.ok(names.has(table + "_e2e_guard_update"), table);
  }

  for (const op of ops) {
    const server = openDb();
    user(server.db, "u");
    op.setup?.(server.db);
    op.insert(server.db);
    assert.equal(op.read(server.db), op.inserted, op.table + " server insert");
    op.update(server.db);
    assert.equal(op.read(server.db), op.updated, op.table + " server update");

    for (const mode of ["e2e", "x"]) {
      const { db } = openDb();
      user(db, "u");
      op.setup?.(db);
      setMode(db, mode);
      assert.throws(() => op.insert(db), ABORT, op.table + " " + mode + " insert");
      assert.equal(count(db, op.table), 0, op.table + " " + mode + " insert persisted");
      setMode(db, "server");
      op.insert(db);
      setMode(db, mode);
      assert.throws(() => op.update(db), ABORT, op.table + " " + mode + " update");
      assert.equal(op.read(db), op.inserted, op.table + " " + mode + " update persisted");
    }
  }
});

test("a plaintext POST checked before the flip is rejected and stores nothing", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    let armed = false;
    const wrapped = {
      prepare(sql: string) {
        const stmt = d1.prepare(sql);
        const wrap = (bound: ReturnType<typeof stmt.bind>) => ({
          async first<T>() {
            const row = await bound.first<T>();
            if (sql.includes("encryption_mode")) armed = true;
            return row;
          },
          async all<T>() {
            return bound.all<T>();
          },
          async run() {
            if (armed && /\b(?:INSERT|UPDATE)\b/i.test(sql)) {
              armed = false;
              db.prepare("UPDATE user SET encryption_mode = 'e2e' WHERE id = ?").run("ana");
            }
            return bound.run();
          },
        });
        return { bind(...values: unknown[]) { return wrap(stmt.bind(...values)); } };
      },
      batch: d1.batch.bind(d1),
    };
    setEnv(wrapped);
    asUser("ana");
    const routes = await import("../app/api/data/[resource]/route.ts");
    const res = await call(routes, "POST", "http://t.local/api/data/contacts", {
      params: { resource: "contacts" },
      json: { name: "Ana" },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: ENCRYPTED });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((db.prepare("SELECT encryption_mode AS m FROM user WHERE id = 'ana'").get() as { m: string }).m, "e2e");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n, 0);
  });
});

test("an open timer blocks activation and stays plaintext legacy data", async () => {
  const { db, d1 } = openDb();
  user(db, "ana");
  db.prepare("INSERT INTO timer_state (user_id,started_at,accumulated_ms,updated_at) VALUES (?,?,?,?)").run("ana", 5, 0, 1);
  const blocked = await addWrap(d1, "ana", { id: "pw", type: "password", wrap: passwordWrap(), credentialId: null }, 1);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, LEGACY_DATA_ERROR);
  assert.equal(await encryptionMode(d1, "ana"), "server");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_keys").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT started_at AS s FROM timer_state WHERE user_id = 'ana'").get() as { s: number }).s, 5);

  const forced = openDb();
  user(forced.db, "ana");
  forced.db.prepare("INSERT INTO timer_state (user_id,started_at,accumulated_ms,updated_at) VALUES (?,?,?,?)").run("ana", 9, 0, 1);
  forced.db.prepare("UPDATE user SET encryption_mode = 'e2e' WHERE id = 'ana'").run();
  const listed = await listKeys(forced.d1, "ana");
  assert.equal(listed.mode, "e2e");
  assert.equal(listed.legacyData, true);
});

test("the sql.js client schema does not install the plaintext-write triggers", async () => {
  assert.equal(LOCAL_SCHEMA_SQL.includes("e2e_account_plaintext_write"), false);
  assert.equal(LOCAL_SCHEMA_SQL.includes("_e2e_guard_"), false);
  const wasm = readFileSync(new URL("../public/vendor/sql-wasm.wasm", import.meta.url));
  const { db, d1 } = await openLocalDb({ wasm });
  const triggers = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%e2e_guard%'").all<{ name: string }>();
  assert.deepEqual(triggers.results ?? [], []);
  await d1.prepare("INSERT INTO contacts (id, user_id, kind, name, created_at, updated_at) VALUES ('c', 'missing-user', 'person', 'Ada', 1, 1)").run();
  await d1.prepare("UPDATE contacts SET name = 'Ada 2' WHERE id = 'c'").run();
  const row = await d1.prepare("SELECT name FROM contacts WHERE id = 'c'").first<{ name: string }>();
  assert.equal(row?.name, "Ada 2");
  db.close();
});
