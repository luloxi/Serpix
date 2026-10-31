import { asUser, call, locked, setEnv } from "./route-harness.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importDek } from "../lib/crypto/dek.ts";
import { validateEnvelope, LEGACY_TABLES, PLAINTEXT_GUARD_TABLES } from "../lib/e2e-server.ts";
import { closeEngine, startEngine, type Engine } from "../lib/e2e/engine.ts";
import { matchLocalPath } from "../lib/e2e/local-api.ts";
import { openDb, seedUser } from "./db-shim.mts";
import type { DatabaseSync } from "node:sqlite";

const data = await import("../app/api/data/[resource]/route.ts");
const dataId = await import("../app/api/data/[resource]/[id]/route.ts");
const luma = await import("../app/api/luma-events/route.ts");
const e2eKeys = await import("../app/api/e2e/keys/route.ts");
const e2eList = await import("../app/api/e2e/records/route.ts");
const e2eRecord = await import("../app/api/e2e/records/[collection]/[id]/route.ts");

const BASE = "http://t.local";
const DAY = 86_400_000;
const SENTINEL = "METNOTE-7f3c1a-hablamos-de-luma-secreto";
const wasm = readFileSync(new URL("../public/vendor/sql-wasm.wasm", import.meta.url));

type Item = { id: string; name: string; metEvent: string | null; metEventAt: string | null; metNote: string | null; startsAt?: string; endsAt?: string | null; url?: string | null; location?: string | null };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function insertLuma(db: DatabaseSync, id: string, userId: string, name: string, startsAt: string, endsAt: string | null = null) {
  db.prepare("INSERT INTO luma_events (id,user_id,uid,name,starts_at,ends_at,url,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, userId, id, name, startsAt, endsAt, "https://lu.ma/" + id, "Sala", 1, 1);
}

function insertContact(db: DatabaseSync, id: string, userId: string, name: string, metEvent: string | null, metNote: string | null) {
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,met_event,met_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, "person", name, metEvent, metNote, 1, 1);
}

test("migration 0018 only adds contact columns and luma_events", () => {
  const sql = readFileSync(new URL("../migrations/0018_contact_events.sql", import.meta.url), "utf8");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.equal(/\bDROP\b/i.test(code), false);
  assert.equal(/\bDELETE\s+FROM\b/i.test(code), false);
  assert.equal(/\bRENAME\b/i.test(code), false);
  assert.equal(/e2e_guard/i.test(sql), false);
  assert.match(sql, /ALTER TABLE contacts ADD COLUMN met_event TEXT/);
  assert.match(sql, /ALTER TABLE contacts ADD COLUMN met_event_at TEXT/);
  assert.match(sql, /ALTER TABLE contacts ADD COLUMN met_note TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS luma_events/);
  assert.match(sql, /UNIQUE\(user_id, uid\)/);
  assert.match(sql, /idx_luma_events_user_starts/);
  assert.equal((LEGACY_TABLES as readonly string[]).includes("luma_events"), false);
  assert.equal((PLAINTEXT_GUARD_TABLES as readonly string[]).includes("luma_events"), false);
  const { db } = openDb();
  const columns = db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>;
  for (const name of ["met_event", "met_event_at", "met_note"]) assert.equal(columns.some((column) => column.name === name), true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='luma_events'").get() as { n: number }).n, 0);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_luma_events_user_starts'").get());
  db.exec("DROP TABLE luma_events");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='luma_events'").get(), undefined);
});

test("contacts create, patch and list the meeting fields and reject a bad date", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    seedUser(db, "ada");
    seedUser(db, "bob");
    asUser("ada");
    setEnv(d1);
    const created = await call(data, "POST", BASE + "/api/data/contacts", {
      params: { resource: "contacts" },
      json: { name: "  Ada Lovelace  ", metEvent: "  Meetup  ", metEventAt: " 2026-10-31 ", metNote: "  hablamos de luma  " },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { id: string }).id;
    const list = await call(data, "GET", BASE + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.equal(list.status, 200);
    const item = (list.body as { items: Item[] }).items.find((row) => row.id === id);
    assert.ok(item);
    assert.equal(item!.metEvent, "Meetup");
    assert.equal(item!.metEventAt, "2026-10-31");
    assert.equal(item!.metNote, "hablamos de luma");

    const blank = await call(data, "POST", BASE + "/api/data/contacts", {
      params: { resource: "contacts" },
      json: { name: "Sin fecha", metEvent: "   ", metEventAt: "   ", metNote: "" },
    });
    assert.equal(blank.status, 201, JSON.stringify(blank.body));
    const blankId = (blank.body as { id: string }).id;
    const listed = await call(data, "GET", BASE + "/api/data/contacts", { params: { resource: "contacts" } });
    const empty = (listed.body as { items: Item[] }).items.find((row) => row.id === blankId);
    assert.equal(empty!.metEvent, null);
    assert.equal(empty!.metEventAt, null);
    assert.equal(empty!.metNote, null);

    const before = (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
    for (const metEventAt of ["2026-02-31", "31/10/2026", "ayer"]) {
      const bad = await call(data, "POST", BASE + "/api/data/contacts", { params: { resource: "contacts" }, json: { name: "Mala", metEventAt } });
      assert.equal(bad.status, 400, metEventAt);
      assert.equal((bad.body as { error: string }).error, "Fecha de evento inválida");
    }
    const typed = await call(data, "POST", BASE + "/api/data/contacts", { params: { resource: "contacts" }, json: { name: "Mala", metEventAt: 20261031 } });
    assert.equal(typed.status, 400);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n, before);

    const long = await call(data, "POST", BASE + "/api/data/contacts", {
      params: { resource: "contacts" },
      json: { name: "Largo", metEvent: "e".repeat(250), metNote: "n".repeat(6000), metEventAt: null },
    });
    assert.equal(long.status, 201, JSON.stringify(long.body));
    const longId = (long.body as { id: string }).id;
    const stored = db.prepare("SELECT met_event, met_note FROM contacts WHERE id=?").get(longId) as { met_event: string; met_note: string };
    assert.equal(stored.met_event.length, 200);
    assert.equal(stored.met_note.length, 5000);

    const patched = await call(dataId, "PATCH", BASE + "/api/data/contacts/" + id, {
      params: { resource: "contacts", id },
      json: { name: "Ada Lovelace", metEvent: "Otro", metEventAt: "2026-11-02", metNote: "seguimos" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const after = db.prepare("SELECT met_event, met_event_at, met_note FROM contacts WHERE id=?").get(id) as { met_event: string; met_event_at: string; met_note: string };
    assert.equal(after.met_event, "Otro");
    assert.equal(after.met_event_at, "2026-11-02");
    assert.equal(after.met_note, "seguimos");
    const rejected = await call(dataId, "PATCH", BASE + "/api/data/contacts/" + id, {
      params: { resource: "contacts", id },
      json: { name: "Ada Lovelace", metEventAt: "no-es-fecha" },
    });
    assert.equal(rejected.status, 400);
    const kept = db.prepare("SELECT met_event, met_event_at, met_note FROM contacts WHERE id=?").get(id) as { met_event: string; met_event_at: string; met_note: string };
    assert.equal(kept.met_event, "Otro");
    assert.equal(kept.met_event_at, "2026-11-02");
    assert.equal(kept.met_note, "seguimos");

    asUser("bob");
    const foreign = await call(dataId, "PATCH", BASE + "/api/data/contacts/" + id, {
      params: { resource: "contacts", id },
      json: { name: "Robado", metEvent: "Ajeno" },
    });
    assert.equal(foreign.status, 404);
    assert.equal((db.prepare("SELECT name FROM contacts WHERE id=?").get(id) as { name: string }).name, "Ada Lovelace");
    const bobs = await call(data, "GET", BASE + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.deepEqual((bobs.body as { items: Item[] }).items, []);
  });
});

test("luma suggestions are user scoped, drop after a week, and stay when that user already used the name", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    seedUser(db, "ada");
    seedUser(db, "bob");
    const now = Date.now();
    insertLuma(db, "recent", "ada", "Visible", iso(now - 2 * DAY), iso(now - DAY));
    insertLuma(db, "long", "ada", "Sigue", iso(now - 10 * DAY), iso(now - DAY));
    insertLuma(db, "old", "ada", "OldHidden", iso(now - 40 * DAY), iso(now - 30 * DAY));
    insertLuma(db, "kept", "ada", "OldKept", iso(now - 50 * DAY), iso(now - 30 * DAY));
    insertLuma(db, "bobs", "bob", "De Bob", iso(now - DAY), iso(now - DAY));
    insertContact(db, "c-ada", "ada", "Ada", "  oldkept  ", SENTINEL);
    insertContact(db, "c-bob", "bob", "Bob", "OldHidden", "nota de bob");
    asUser("ada");
    setEnv(d1);
    const listed = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(listed.status, 200);
    const items = (listed.body as { items: Item[] }).items;
    assert.deepEqual(items.map((item) => item.name), ["Visible", "Sigue", "OldKept"]);
    assert.equal(JSON.stringify(listed.body).includes(SENTINEL), false);
    assert.equal(JSON.stringify(listed.body).includes("nota de bob"), false);
    assert.deepEqual(Object.keys(items[0]!).sort(), ["endsAt", "id", "location", "name", "startsAt", "url"]);
    assert.equal(items.find((item) => item.id === "kept")!.url, "https://lu.ma/kept");

    for (let i = 0; i < 205; i++) insertLuma(db, "n" + i, "ada", "N" + i, iso(now + (i + 3) * 3_600_000));
    const capped = await call(luma, "GET", BASE + "/api/luma-events");
    const names = (capped.body as { items: Item[] }).items;
    assert.equal(names.length, 200);
    assert.equal(names[0]!.id, "n204");
    assert.equal(names.some((item) => item.id === "n0"), false);

    asUser(null);
    const anon = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.body, { error: "Unauthorized" });
    asUser("ada", "user", "pending");
    const pending = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(pending.status, 401);

    asUser("ada");
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='ada'").run();
    const encrypted = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(encrypted.status, 200);
    assert.equal(JSON.stringify(encrypted.body).includes(SENTINEL), false);
    const contacts = await call(data, "GET", BASE + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.equal(contacts.status, 403);

    db.exec("DROP TABLE luma_events");
    const missing = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { items: [] });
    assert.equal(matchLocalPath("/api/luma-events"), null);
  });
});

test("an encrypted contact round-trips the meeting fields without writing them in plaintext", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    const userId = "met-user";
    seedUser(db, userId);
    asUser(userId);
    setEnv(d1);
    const password = { v: 1, type: "password", salt: "s".repeat(43), n: "n".repeat(16), c: "c".repeat(64), m: 65536, t: 3, p: 1, argonSalt: "r".repeat(22) };
    const createdKey = await call(e2eKeys, "POST", BASE + "/api/e2e/keys", { json: { type: "password", wrap: password, id: "pw" } });
    assert.equal(createdKey.status, 201, JSON.stringify(createdKey.body));
    insertLuma(db, "srv", userId, "Visible cifrado", iso(Date.now() + DAY));
    const serverList = await call(luma, "GET", BASE + "/api/luma-events");
    assert.equal(serverList.status, 200);
    assert.equal((serverList.body as { items: Item[] }).items[0]!.name, "Visible cifrado");
    assert.equal(JSON.stringify(serverList.body).includes(SENTINEL), false);

    const dek = await importDek(crypto.getRandomValues(new Uint8Array(32)));
    const serverFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      let mod: Record<string, (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>> | null = null;
      let params: Record<string, string> = {};
      if (path === "/api/e2e/keys") mod = e2eKeys;
      else if (path === "/api/e2e/records") mod = e2eList;
      else {
        const match = path.match(/^\/api\/e2e\/records\/([^/]+)\/([^/]+)$/);
        if (match) {
          mod = e2eRecord;
          params = { collection: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) };
        }
      }
      if (!mod) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      const opts: { text?: string; params: Record<string, string>; headers: Record<string, string> } = { params, headers };
      if (request.method !== "GET" && request.method !== "HEAD") opts.text = await request.text();
      const result = await call(mod, request.method, request.url, opts);
      return new Response(result.text, { status: result.status, headers: result.headers });
    };
    try {
      asUser(userId);
      const a = await startEngine({ userId, dek, wasm, fetch: serverFetch, name: userId, email: userId + "@test.local", baseUrl: BASE });
      const api = async (engine: Engine, method: string, path: string, json?: unknown) => {
        const response = await engine.handle(BASE + path, {
          method,
          headers: json !== undefined ? { "content-type": "application/json" } : undefined,
          body: json !== undefined ? JSON.stringify(json) : undefined,
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
      };
      const contact = await api(a, "POST", "/api/data/contacts", { name: "Ana", metEvent: "Luma BA", metEventAt: "2026-10-31", metNote: SENTINEL });
      assert.equal(contact.status, 201, JSON.stringify(contact.body));
      const id = (contact.body as { id: string }).id;
      await a.push();
      await a.idle();
      const b = await startEngine({ userId, dek, wasm, fetch: serverFetch, name: userId, email: userId + "@test.local", baseUrl: BASE });
      const listed = await api(b, "GET", "/api/data/contacts");
      assert.equal(listed.status, 200);
      const item = (listed.body as { items: Item[] }).items.find((row) => row.id === id);
      assert.ok(item);
      assert.equal(item!.metEvent, "Luma BA");
      assert.equal(item!.metEventAt, "2026-10-31");
      assert.equal(item!.metNote, SENTINEL);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id=?").get(userId) as { n: number }).n, 0);
      const blobs = db.prepare("SELECT blob FROM records WHERE user_id=? AND collection='contacts'").all(userId) as Array<{ blob: string }>;
      assert.ok(blobs.length >= 1);
      for (const row of blobs) {
        assert.equal(validateEnvelope(row.blob).ok, true);
        assert.equal(row.blob.includes(SENTINEL), false);
        assert.equal(row.blob.includes("Luma BA"), false);
      }
    } finally {
      await closeEngine();
    }
  });
});
