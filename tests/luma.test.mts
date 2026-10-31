import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eventSuggestionVisible, LUMA_VISIBLE_MS } from "../lib/luma-events.ts";
import { icsEventDate, parseLumaIcs } from "../lib/luma-ics.ts";
import { syncLumaEvents } from "../lib/luma-sync.ts";
import { resetEncryptionModeCache } from "../lib/mailtox-link.ts";
import { openDb } from "./db-shim.mts";
import type { DatabaseSync } from "node:sqlite";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const root = fileURLToPath(new URL("..", import.meta.url));

function vevent(lines: string[]): string {
  return "BEGIN:VEVENT\r\n" + lines.join("\r\n") + "\r\nEND:VEVENT\r\n";
}

function feed(body: string): string {
  return "BEGIN:VCALENDAR\r\n" + body + "END:VCALENDAR\r\n";
}

function admin(db: DatabaseSync, id: string, email: string, role: "admin" | "user" = "admin") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, "approved");
}

function countLuma(db: DatabaseSync, userId?: string): number {
  const row = userId
    ? db.prepare("SELECT COUNT(*) AS n FROM luma_events WHERE user_id=?").get(userId) as { n: number }
    : db.prepare("SELECT COUNT(*) AS n FROM luma_events").get() as { n: number };
  return row.n;
}

test("ICS parser unfolds, unescapes, converts zones, skips cancelled, and caps the window", () => {
  const folded = feed(vevent([
    "UID:fold-1",
    "SUMMARY:Hola",
    "  mundo",
    "DTSTART:20261031T190000Z",
    "LOCATION:Café\\, mesa\\nnota",
    "URL:https://lu.ma/hola",
  ]).replace("SUMMARY:Hola\r\n  mundo", "SUMMARY:Hola\r\n  mundo"));
  const parsed = parseLumaIcs(folded, NOW);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, "Hola mundo");
  assert.equal(parsed[0]!.startsAt, "2026-10-31T19:00:00.000Z");
  assert.equal(parsed[0]!.location, "Café, mesa\nnota");
  assert.equal(parsed[0]!.url, "https://lu.ma/hola");
  assert.equal(icsEventDate(parsed[0]!.startsAt), "2026-10-31");

  const zoned = parseLumaIcs(feed(vevent([
    "UID:ba",
    "SUMMARY:Buenos Aires",
    "DTSTART;TZID=America/Argentina/Buenos_Aires:20261031T190000",
    "DTEND;TZID=America/Argentina/Buenos_Aires:20261031T200000",
  ])), NOW);
  assert.equal(zoned[0]!.startsAt, "2026-10-31T22:00:00.000Z");
  assert.equal(zoned[0]!.endsAt, "2026-10-31T23:00:00.000Z");

  const ny = parseLumaIcs(feed(vevent([
    "UID:ny",
    "SUMMARY:Nueva York",
    "DTSTART;TZID=America/New_York:20261031T190000",
  ])), NOW);
  assert.equal(ny[0]!.startsAt, "2026-10-31T23:00:00.000Z");
  assert.equal(ny[0]!.endsAt, null);

  const floating = parseLumaIcs(feed(vevent([
    "UID:float",
    "SUMMARY:Flotante",
    "DTSTART:20261031T190000",
  ])), NOW);
  assert.equal(floating[0]!.startsAt, "2026-10-31T22:00:00.000Z");

  const allDay = parseLumaIcs(feed(vevent([
    "UID:day",
    "SUMMARY:Dia entero",
    "DTSTART;VALUE=DATE:20261031",
    "DTEND;VALUE=DATE:20261101",
  ])), NOW);
  assert.equal(allDay[0]!.startsAt, "2026-10-31T03:00:00.000Z");
  assert.equal(allDay[0]!.endsAt, "2026-11-01T03:00:00.000Z");
  assert.equal(icsEventDate(allDay[0]!.startsAt), "2026-10-31");

  const impliedEnd = parseLumaIcs(feed(vevent([
    "UID:day2",
    "SUMMARY:Sin fin",
    "DTSTART;VALUE=DATE:20261031",
  ])), NOW);
  assert.equal(impliedEnd[0]!.endsAt, "2026-11-01T03:00:00.000Z");

  const skipped = parseLumaIcs(feed(
    vevent(["UID:gone", "SUMMARY:Cancelada", "DTSTART:20261031T190000Z", "STATUS:cancelled"])
    + vevent(["UID:norule", "SUMMARY:Una vez", "DTSTART:20261031T180000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20261107T180000Z"])
    + vevent(["UID:alarm", "SUMMARY:Real", "DTSTART:20261031T170000Z", "BEGIN:VALARM", "SUMMARY:Alarm noise", "ACTION:DISPLAY", "END:VALARM"])
    + vevent(["UID:badtz", "SUMMARY:Zona mala", "DTSTART;TZID=Not/AZone:20261031T190000"])
    + vevent(["SUMMARY:Sin uid", "DTSTART:20261031T190000Z"]),
  ), NOW);
  assert.deepEqual(skipped.map((event) => event.uid), ["norule", "alarm"]);
  assert.equal(skipped.find((event) => event.uid === "alarm")!.name, "Real");

  const pastEdge = new Date(NOW - 14 * DAY).toISOString().replace(/[-:]/g, "").replace(".000", "");
  const pastIcs = pastEdge.slice(0, 8) + "T" + pastEdge.slice(9, 15) + "Z";
  const futureEdge = new Date(NOW + 180 * DAY).toISOString().replace(/[-:]/g, "").replace(".000", "");
  const futureIcs = futureEdge.slice(0, 8) + "T" + futureEdge.slice(9, 15) + "Z";
  const tooOld = new Date(NOW - 14 * DAY - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const tooOldIcs = tooOld.slice(0, 8) + "T" + tooOld.slice(9, 15) + "Z";
  const edges = parseLumaIcs(feed(
    vevent(["UID:past", "SUMMARY:Borde pasado", "DTSTART:" + pastIcs])
    + vevent(["UID:future", "SUMMARY:Borde futuro", "DTSTART:" + futureIcs])
    + vevent(["UID:older", "SUMMARY:Muy viejo", "DTSTART:" + tooOldIcs])
    + vevent(["UID:later", "SUMMARY:Muy lejos", "DTSTART:" + new Date(NOW + 180 * DAY + 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(0, 15) + "Z"]),
  ), NOW);
  assert.deepEqual(edges.map((event) => event.uid).sort(), ["future", "past"]);

  let many = "";
  for (let i = 0; i < 301; i++) many += vevent(["UID:u" + i, "SUMMARY:E" + i, "DTSTART:20261031T120000Z"]);
  assert.equal(parseLumaIcs(feed(many), NOW).length, 300);

  const early = vevent(["UID:early", "SUMMARY:Early", "DTSTART:20261031T120000Z"]);
  const late = vevent(["UID:late", "SUMMARY:LateMarker", "DTSTART:20261031T120000Z"]);
  const capped = parseLumaIcs(early + "X".repeat(2 * 1024 * 1024) + late, NOW);
  assert.equal(capped.some((event) => event.uid === "early"), true);
  assert.equal(capped.some((event) => event.name === "LateMarker"), false);

  const cr = parseLumaIcs("BEGIN:VEVENT\rUID:cr\rSUMMARY:Hola\r  mundo\rDTSTART:20261031T190000Z\rEND:VEVENT\r", NOW);
  assert.equal(cr[0]!.name, "Hola mundo");
});

test("an event stays suggested through the exact 7 day boundary, and only this user's contact keeps it after that", () => {
  const endsAt = "2026-10-24T15:00:00.000Z";
  const boundary = Date.parse(endsAt) + LUMA_VISIBLE_MS;
  const event = { name: "Meetup", startsAt: "2026-10-24T12:00:00.000Z", endsAt, userId: "ada" };
  assert.equal(eventSuggestionVisible(event, [], boundary), true);
  assert.equal(eventSuggestionVisible(event, [], boundary + 1), false);
  assert.equal(eventSuggestionVisible(event, [{ userId: "ada", metEvent: "  meetup  " }], boundary + 1), true);
  assert.equal(eventSuggestionVisible(event, [{ userId: "bob", metEvent: "Meetup" }], boundary + 1), false);
  assert.equal(eventSuggestionVisible({ ...event, endsAt: "   " }, [], Date.parse(event.startsAt) + LUMA_VISIBLE_MS), true);
  assert.equal(eventSuggestionVisible({ ...event, endsAt: null, name: "   " }, [], boundary + DAY), false);
  assert.equal(eventSuggestionVisible({ ...event, startsAt: "2026-12-01T00:00:00.000Z", endsAt: null }, [], boundary + DAY), true);
});

test("Luma sync upserts the owner calendar, dedupes, and never deletes", async () => {
  resetEncryptionModeCache();
  const { db, d1 } = openDb();
  const email = "owner@luma.test";
  admin(db, "owner", email);
  const now = new Date(NOW);
  const one = feed(vevent(["UID:u1", "SUMMARY:Charla", "DTSTART:20261031T190000Z", "LOCATION:Sala", "URL:https://lu.ma/charla"]));
  let fetches = 0;
  const okFetch = async () => {
    fetches += 1;
    return new Response(one, { status: 200 });
  };
  const first = await syncLumaEvents(d1, email, "https://api.lu.ma/cal.ics", okFetch as typeof fetch, now);
  assert.deepEqual(first, { status: "ok", inserted: 1, updated: 0 });
  const created = db.prepare("SELECT id, created_at, name, starts_at, url, location FROM luma_events WHERE uid='u1'").get() as { id: string; created_at: number; name: string; starts_at: string; url: string; location: string };
  assert.equal(created.name, "Charla");
  assert.equal(created.starts_at, "2026-10-31T19:00:00.000Z");
  assert.equal(created.url, "https://lu.ma/charla");
  assert.equal(created.location, "Sala");

  const again = await syncLumaEvents(d1, "  " + email.toUpperCase() + " ", "https://api.lu.ma/cal.ics", okFetch as typeof fetch, now);
  assert.deepEqual(again, { status: "ok", inserted: 0, updated: 1 });
  assert.equal(countLuma(db), 1);
  const same = db.prepare("SELECT id, created_at FROM luma_events WHERE uid='u1'").get() as { id: string; created_at: number };
  assert.equal(same.id, created.id);
  assert.equal(same.created_at, created.created_at);

  const renamed = feed(vevent(["UID:u1", "SUMMARY:Charla nueva", "DTSTART:20261031T190000Z"]) + vevent(["UID:u1", "SUMMARY:Charla final", "DTSTART:20261031T200000Z"]));
  const renamedFetch = async () => new Response(renamed, { status: 200 });
  const third = await syncLumaEvents(d1, email, "https://api.lu.ma/cal.ics", renamedFetch as typeof fetch, now);
  assert.deepEqual(third, { status: "ok", inserted: 0, updated: 1 });
  const row = db.prepare("SELECT name, starts_at, created_at FROM luma_events WHERE uid='u1'").get() as { name: string; starts_at: string; created_at: number };
  assert.equal(row.name, "Charla final");
  assert.equal(row.starts_at, "2026-10-31T20:00:00.000Z");
  assert.equal(row.created_at, created.created_at);

  db.prepare("INSERT INTO luma_events (id,user_id,uid,name,starts_at,ends_at,url,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("keep", "owner", "old", "Manual", "2026-10-20T15:00:00.000Z", null, null, null, 5, 5);
  const smaller = feed(vevent(["UID:u1", "SUMMARY:Charla final", "DTSTART:20261031T200000Z"]));
  const fourth = await syncLumaEvents(d1, email, "https://api.lu.ma/cal.ics", (async () => new Response(smaller, { status: 200 })) as typeof fetch, now);
  assert.equal(fourth.status, "ok");
  assert.equal(countLuma(db, "owner"), 2);
  assert.equal((db.prepare("SELECT name FROM luma_events WHERE uid='old'").get() as { name: string }).name, "Manual");

  const duplicate = feed(vevent(["UID:other", "SUMMARY:Charla final", "DTSTART:20261031T180000Z"]));
  const beforeDup = countLuma(db);
  const dup = await syncLumaEvents(d1, email, "https://api.lu.ma/cal.ics", (async () => new Response(duplicate, { status: 200 })) as typeof fetch, now);
  assert.deepEqual(dup, { status: "ok", inserted: 0, updated: 0 });
  assert.equal(countLuma(db), beforeDup);

  let batches = 0;
  const original = d1.batch!.bind(d1);
  d1.batch = async (statements) => {
    batches += 1;
    return original(statements);
  };
  const extra = feed(vevent(["UID:u9", "SUMMARY:Otra", "DTSTART:20261102T150000Z"]));
  const batched = await syncLumaEvents(d1, email, "https://api.lu.ma/cal.ics", (async () => new Response(extra, { status: 200 })) as typeof fetch, now);
  assert.equal(batched.status, "ok");
  if (batched.status === "ok") assert.equal(batched.inserted, 1);
  assert.equal(batches, 1);
  assert.ok(fetches >= 2);
  const bare = { prepare: d1.prepare.bind(d1) };
  const seq = await syncLumaEvents(bare, email, "https://api.lu.ma/cal.ics", (async () => new Response(feed(vevent(["UID:seq", "SUMMARY:Secuencial", "DTSTART:20261103T150000Z"])), { status: 200 })) as typeof fetch, now);
  assert.deepEqual(seq, { status: "ok", inserted: 1, updated: 0 });
  assert.equal(countLuma(db, "owner") >= 3, true);
});

test("a missing secret, a non-owner, and an encrypted owner skip the fetch and leave every row", async () => {
  resetEncryptionModeCache();
  const { db, d1 } = openDb();
  admin(db, "owner", "owner@luma.test");
  db.prepare("INSERT INTO luma_events (id,user_id,uid,name,starts_at,ends_at,url,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("row", "owner", "uid", "Queda", "2026-10-31T19:00:00.000Z", null, null, null, 1, 1);
  const before = countLuma(db);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const skipped = await syncLumaEvents(d1, undefined, "  ", fetchImpl);
    assert.deepEqual(skipped, { status: "skipped" });
    assert.deepEqual(logs, ["luma_sync_skipped"]);
    const user = openDb();
    admin(user.db, "person", "person@luma.test", "user");
    resetEncryptionModeCache();
    const denied = await syncLumaEvents(user.d1, "person@luma.test", "https://example.com/SECRETTOKEN123.ics", fetchImpl);
    assert.deepEqual(denied, { status: "no_owner" });
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='owner'").run();
    resetEncryptionModeCache();
    const encrypted = await syncLumaEvents(d1, "owner@luma.test", "https://example.com/SECRETTOKEN123.ics", fetchImpl);
    assert.deepEqual(encrypted, { status: "skipped_e2e" });
    assert.equal(calls, 0);
    db.prepare("UPDATE user SET encryption_mode='server' WHERE id='owner'").run();
    resetEncryptionModeCache();
    const plain = await syncLumaEvents(d1, "owner@luma.test", "http://example.com/cal.ics", fetchImpl);
    assert.deepEqual(plain, { status: "rejected" });
    assert.equal(calls, 0);
    const secretUrl = "https://api.lu.ma/ics/SECRETTOKEN123";
    const failed = await syncLumaEvents(d1, "owner@luma.test", secretUrl, (async () => { throw new Error("down " + secretUrl); }) as typeof fetch);
    assert.deepEqual(failed, { status: "rejected" });
    const huge = await syncLumaEvents(d1, "owner@luma.test", secretUrl, (async (_input: unknown, init?: RequestInit) => {
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal);
      return new Response("x", { status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
    }) as typeof fetch);
    assert.deepEqual(huge, { status: "rejected" });
    const streamed = await syncLumaEvents(d1, "owner@luma.test", secretUrl, (async () => {
      const chunk = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch);
    assert.deepEqual(streamed, { status: "rejected" });
    const hopped = await syncLumaEvents(d1, "owner@luma.test", "https://api.lu.ma/a.ics", (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/a.ics")) return new Response(null, { status: 302, headers: { location: "http://evil.example/cal.ics" } });
      throw new Error("followed " + url);
    }) as typeof fetch);
    assert.deepEqual(hopped, { status: "rejected" });
    const followed = await syncLumaEvents(d1, "owner@luma.test", "https://api.lu.ma/a.ics", (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/a.ics")) return new Response(null, { status: 302, headers: { location: "https://api.lu.ma/b.ics" } });
      assert.equal(url, "https://api.lu.ma/b.ics");
      return new Response(feed(vevent(["UID:hop", "SUMMARY:Salto", "DTSTART:20261031T190000Z"])), { status: 200 });
    }) as typeof fetch);
    assert.deepEqual(followed, { status: "ok", inserted: 1, updated: 0 });
    const blob = logs.join("\n") + "\n" + errors.join("\n");
    assert.equal(blob.includes("SECRETTOKEN123"), false);
    assert.equal(blob.includes("example.com"), false);
    assert.ok(errors.some((line) => line.includes("luma_sync_failed")));
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.equal(countLuma(db) >= before, true);
  assert.equal((db.prepare("SELECT name FROM luma_events WHERE uid='uid'").get() as { name: string }).name, "Queda");
});

test("the six-hour cron only syncs Luma and the secret stays out of git", () => {
  const worker = readFileSync(root + "worker.ts", "utf8");
  const wrangler = readFileSync(root + "wrangler.jsonc", "utf8");
  const secrets = readFileSync(root + "cloudflare-env.secrets.d.ts", "utf8");
  const readme = readFileSync(root + "README.md", "utf8");
  assert.match(wrangler, /"0 12 \* \* \*"/);
  assert.match(wrangler, /"30 \*\/6 \* \* \*"/);
  assert.match(worker, /event\.cron === "30 \*\/6 \* \* \*"/);
  assert.match(worker, /\["luma_sync", \(\) => runLumaSync\(env\)\]/);
  assert.match(secrets, /LUMA_ICS_URL\?: string/);
  assert.match(readme, /wrangler secret put LUMA_ICS_URL/);
  assert.match(readme, /Calendar → Subscribe \/ Add to calendar/);
  assert.equal(wrangler.includes("https://"), false);
});
