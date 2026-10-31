import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runWithEngineSession } from "../lib/e2e/ambient.ts";
import { LEGACY_TABLES, PLAINTEXT_GUARD_TABLES } from "../lib/e2e-server.ts";
import { decryptLumaUrl, encryptLumaUrl, LUMA_KEY_ERROR } from "../lib/luma-secret.ts";
import { LUMA_DECRYPT_ERROR, LUMA_MISSING_ERROR, LUMA_RATE_LIMIT_ERROR, readLumaSettings, runLumaSyncForOwner, saveLumaLink, syncLumaSettings } from "../lib/luma-settings.ts";
import { syncLumaEvents } from "../lib/luma-sync.ts";
import { lumaHint, LUMA_SYNC_ERROR, LUMA_URL_ERROR, MAX_LUMA_URL_LENGTH, normalizeLumaUrl, redactText } from "../lib/luma-url.ts";
import { resetEncryptionModeCache } from "../lib/mailtox-link.ts";
import { openDb } from "./db-shim.mts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import type { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("..", import.meta.url));
const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const TOKEN = "SECRET-TOKEN-luma";
const ICS = "https://api.lu.ma/ics/feed/" + TOKEN + "-abcd";
const ENV_ICS = "https://api.lu.ma/ics/env/" + TOKEN + "-envw";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function vevent(lines: string[]): string {
  return "BEGIN:VEVENT\r\n" + lines.join("\r\n") + "\r\nEND:VEVENT\r\n";
}

function feed(body = vevent(["UID:u1", "SUMMARY:Charla", "DTSTART:20261031T190000Z"])): string {
  return "BEGIN:VCALENDAR\r\n" + body + "END:VCALENDAR\r\n";
}

function person(db: DatabaseSync, id: string, email: string, role: "admin" | "user" = "admin") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, "approved");
}

function ownerEnv(extra: Record<string, unknown> = {}) {
  return { MCP_OWNER_EMAIL: "owner@test.local", LUMA_SETTINGS_KEY: KEY, ...extra };
}

test("migration 0019 only adds luma_settings and skips the plaintext guard", () => {
  const sql = readFileSync(root + "migrations/0019_luma_settings.sql", "utf8");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.equal(/\bDROP\b/i.test(code), false);
  assert.equal(/\bDELETE\s+FROM\b/i.test(code), false);
  assert.equal(/\bRENAME\b/i.test(code), false);
  assert.equal(/e2e_guard/i.test(sql), false);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS luma_settings/);
  assert.match(sql, /ics_cipher TEXT/);
  assert.equal((LEGACY_TABLES as readonly string[]).includes("luma_settings"), false);
  assert.equal((PLAINTEXT_GUARD_TABLES as readonly string[]).includes("luma_settings"), false);
  const { db } = openDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='luma_settings'").get() as { n: number }).n, 0);
  const columns = (db.prepare("PRAGMA table_info(luma_settings)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.deepEqual(columns, ["user_id", "ics_cipher", "ics_iv", "ics_hint", "saved_at", "last_attempt_at", "last_sync_at", "last_status", "last_count", "last_error", "updated_at"]);
});

test("AES-GCM roundtrip, tamper, wrong AAD and a missing key", async () => {
  const sealed = await encryptLumaUrl(ICS, "owner", KEY);
  assert.equal(await decryptLumaUrl(sealed.cipher, sealed.iv, "owner", KEY), ICS);
  assert.equal(sealed.cipher.includes(TOKEN), false);
  assert.equal(sealed.iv.includes(TOKEN), false);
  const again = await encryptLumaUrl(ICS, "owner", KEY);
  assert.notEqual(again.iv, sealed.iv);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const flipped = alphabet[(alphabet.indexOf(sealed.cipher[0] ?? "A") + 1) % alphabet.length] + sealed.cipher.slice(1);
  await assert.rejects(() => decryptLumaUrl(flipped, sealed.iv, "owner", KEY));
  await assert.rejects(() => decryptLumaUrl(sealed.cipher, sealed.iv, "other", KEY));
  await assert.rejects(() => decryptLumaUrl(sealed.cipher, sealed.iv, "owner", OTHER_KEY));
  for (const bad of [undefined, "", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
    await assert.rejects(() => encryptLumaUrl(ICS, "owner", bad), (error: unknown) => error instanceof Error && error.message === LUMA_KEY_ERROR);
    await assert.rejects(() => decryptLumaUrl(sealed.cipher, sealed.iv, "owner", bad), (error: unknown) => error instanceof Error && error.message === LUMA_KEY_ERROR);
  }
});

test("Luma ICS validator accepts only https hosts under lu.ma or luma.com", () => {
  const ok = [
    "https://api.lu.ma/ics/abcd",
    "https://API.LU.MA/ics/Abcd",
    "  https://lu.ma/x  ",
    "https://luma.com/x",
    "https://api.luma.com/ics/abcd",
    "https://sub.api.lu.ma/x",
    "webcal://api.lu.ma/ics/abcd",
    "WEBCAL://api.lu.ma/ics/abcd",
    "https://api.lu.ma:443/ics/abcd",
    "https://api.lu.ma./ics/abcd",
  ];
  for (const value of ok) {
    const normalized = normalizeLumaUrl(value);
    assert.equal(typeof normalized, "string", value);
    assert.match(normalized ?? "", /^https:\/\//);
  }
  assert.equal(normalizeLumaUrl("webcal://api.lu.ma/ics/abcd"), "https://api.lu.ma/ics/abcd");
  assert.equal(lumaHint("https://API.LU.MA/ics/feed/SECRET-TOKEN-luma-abcd"), "api.lu.ma/…abcd");

  const long = "https://api.lu.ma/" + "a".repeat(MAX_LUMA_URL_LENGTH - "https://api.lu.ma/".length);
  assert.equal(long.length, MAX_LUMA_URL_LENGTH);
  assert.equal(typeof normalizeLumaUrl(long), "string");
  const tooLong = long + "a";
  const rejected = [
    tooLong,
    "http://api.lu.ma/ics/abcd",
    "ftp://api.lu.ma/ics/abcd",
    "https://user:pass@api.lu.ma/ics/abcd",
    "https://luma.com@evil.com/ics/abcd",
    "https://api.lu.ma:8443/ics/abcd",
    "https://evilluma.com/ics/abcd",
    "https://lu.ma.evil.com/ics/abcd",
    "https://api.lu.ma.evil.com/ics/abcd",
    "https://notlu.ma/ics/abcd",
    "https://luma.com.evil.com/x",
    "https://evil.com/lu.ma",
    "",
    "   ",
    "javascript:alert(1)",
    "https://1.2.3.4/ics/abcd",
  ];
  for (const value of rejected) assert.equal(normalizeLumaUrl(value), null, value);
  assert.equal(normalizeLumaUrl(123), null);
  assert.equal(redactText("down " + ICS, [ICS]).includes(TOKEN), false);
  assert.equal(redactText("down " + ICS, [ICS]).includes("api.lu.ma"), false);
});

test("redirect hops stay on Luma https and stop after three", async () => {
  resetEncryptionModeCache();
  const { db, d1 } = openDb();
  person(db, "owner", "owner@luma.test");
  const chain = ["https://api.lu.ma/h0", "https://api.lu.ma/h1", "https://api.lu.ma/h2", "https://api.lu.ma/h3"];
  const seen: string[] = [];
  const hopped = await syncLumaEvents(d1, "owner@luma.test", chain[0], (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    const index = chain.indexOf(url);
    if (index >= 0 && index < chain.length - 1) return new Response(null, { status: 302, headers: { location: chain[index + 1]! } });
    return new Response(feed(), { status: 200 });
  }) as typeof fetch, new Date(NOW));
  assert.equal(hopped.status, "rejected");
  assert.deepEqual(seen, chain.slice(0, 3));

  const foreign = await syncLumaEvents(d1, "owner@luma.test", "https://api.lu.ma/a.ics", (async (input: unknown) => {
    if (String(input).endsWith("/a.ics")) return new Response(null, { status: 302, headers: { location: "https://evilluma.com/cal.ics" } });
    throw new Error("followed " + String(input));
  }) as typeof fetch, new Date(NOW));
  assert.equal(foreign.status, "rejected");

  const httpHop = await syncLumaEvents(d1, "owner@luma.test", "https://api.lu.ma/a.ics", (async (input: unknown) => {
    if (String(input).endsWith("/a.ics")) return new Response(null, { status: 302, headers: { location: "http://api.lu.ma/b.ics" } });
    throw new Error("followed " + String(input));
  }) as typeof fetch, new Date(NOW));
  assert.equal(httpHop.status, "rejected");

  let requested = "";
  const webcal = await syncLumaEvents(d1, "owner@luma.test", "webcal://api.lu.ma/cal.ics", (async (input: unknown) => {
    requested = String(input);
    return new Response(feed(), { status: 200 });
  }) as typeof fetch, new Date(NOW));
  assert.equal(webcal.status, "ok");
  assert.equal(requested, "https://api.lu.ma/cal.ics");
});

test("settings routes hide the link and the sync records status", async () => {
  await locked(async () => {
    resetEncryptionModeCache();
    const { db, d1 } = openDb();
    person(db, "owner", "owner@test.local");
    person(db, "other", "other@test.local", "admin");
    person(db, "member", "member@test.local", "user");
    db.prepare("INSERT INTO luma_events (id,user_id,uid,name,starts_at,ends_at,url,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("keep", "owner", "keep", "Manual", "2026-10-31T19:00:00.000Z", null, null, null, 1, 1);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM luma_events").get() as { n: number }).n;
    setEnv(d1, ownerEnv());
    const settings = await import("../app/api/settings/luma/route.ts");
    const syncRoute = await import("../app/api/settings/luma/sync/route.ts");
    const base = "http://t.local";

    asUser(null);
    assert.equal((await call(settings, "GET", base + "/api/settings/luma")).status, 401);
    assert.equal((await call(settings, "PUT", base + "/api/settings/luma", { json: { url: ICS } })).status, 401);
    assert.equal((await call(settings, "DELETE", base + "/api/settings/luma")).status, 401);
    assert.equal((await call(syncRoute, "POST", base + "/api/settings/luma/sync")).status, 401);

    asUser("member", "user");
    const forbidden = await call(settings, "PUT", base + "/api/settings/luma", { json: { url: ICS } });
    assert.equal(forbidden.status, 403);
    assert.equal(JSON.stringify(forbidden.body).includes(TOKEN), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM luma_settings").get() as { n: number }).n, 0);

    asUser("other", "admin");
    const notOwner = await call(settings, "GET", base + "/api/settings/luma");
    assert.equal(notOwner.status, 403);
    assert.equal(JSON.stringify(notOwner.body).includes(TOKEN), false);

    asUser("owner", "admin");
    const empty = await call(settings, "GET", base + "/api/settings/luma");
    assert.equal(empty.status, 200);
    assert.equal(empty.headers["cache-control"], "no-store");
    assert.equal((empty.body as { configured: boolean }).configured, false);
    assert.equal((empty.body as { envFallback: boolean }).envFallback, false);

    const bad = await call(settings, "PUT", base + "/api/settings/luma", { json: { url: "https://evilluma.com/SECRET-TOKEN-luma" } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: string }).error, LUMA_URL_ERROR);
    assert.equal(JSON.stringify(bad.body).includes(TOKEN), false);

    const saved = await call(settings, "PUT", base + "/api/settings/luma", { json: { url: "  " + ICS + "  " } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const view = saved.body as { configured: boolean; hint: string; url?: string };
    assert.equal(view.configured, true);
    assert.equal(view.hint, "api.lu.ma/…abcd");
    assert.equal(Object.hasOwn(view, "url"), false);
    assert.equal(JSON.stringify(saved.body).includes(TOKEN), false);
    assert.equal(JSON.stringify(saved.body).includes(ICS), false);
    const row = db.prepare("SELECT * FROM luma_settings WHERE user_id='owner'").get() as Record<string, unknown>;
    const stored = JSON.stringify(row);
    assert.equal(stored.includes(TOKEN), false);
    assert.equal(stored.includes(ICS), false);
    assert.equal(stored.includes("https://"), false);
    assert.equal(typeof row.ics_cipher, "string");
    assert.notEqual(row.ics_cipher, ICS);
    assert.equal(await decryptLumaUrl(String(row.ics_cipher), String(row.ics_iv), "owner", KEY), ICS);

    db.prepare("UPDATE luma_settings SET last_status='ok', last_count=4, last_sync_at=10 WHERE user_id='owner'").run();
    const removed = await call(settings, "DELETE", base + "/api/settings/luma");
    assert.equal(removed.status, 200);
    assert.equal((removed.body as { configured: boolean }).configured, false);
    assert.equal((removed.body as { hint: string | null }).hint, null);
    assert.equal((removed.body as { lastStatus: string }).lastStatus, "ok");
    const cleared = db.prepare("SELECT ics_cipher, ics_iv, ics_hint, last_status FROM luma_settings WHERE user_id='owner'").get() as { ics_cipher: string | null; ics_iv: string | null; ics_hint: string | null; last_status: string };
    assert.equal(cleared.ics_cipher, null);
    assert.equal(cleared.ics_iv, null);
    assert.equal(cleared.ics_hint, null);
    assert.equal(cleared.last_status, "ok");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM luma_settings").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM luma_events").get() as { n: number }).n, before);

    setEnv(d1, ownerEnv());
    const again = await saveLumaLink(d1, "owner", ICS, ownerEnv(), 50);
    assert.equal(again.ok, true);
    db.prepare("UPDATE luma_settings SET last_attempt_at=? WHERE user_id='owner'").run(Date.now());
    const limited = await call(syncRoute, "POST", base + "/api/settings/luma/sync");
    assert.equal(limited.status, 429);
    assert.equal((limited.body as { error: string }).error, LUMA_RATE_LIMIT_ERROR);
    assert.equal(JSON.stringify(limited.body).includes(TOKEN), false);

    db.prepare("UPDATE luma_settings SET last_attempt_at=NULL WHERE user_id='owner'").run();
    const original = globalThis.fetch;
    let seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response(feed(), { status: 200 });
    }) as typeof fetch;
    try {
      const ok = await call(syncRoute, "POST", base + "/api/settings/luma/sync");
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const body = ok.body as { lastStatus: string; lastCount: number; lastError: string | null };
      assert.equal(body.lastStatus, "ok");
      assert.equal(body.lastCount, 1);
      assert.equal(body.lastError, null);
      assert.equal(JSON.stringify(ok.body).includes(TOKEN), false);
      assert.deepEqual(seen, [ICS]);
    } finally {
      globalThis.fetch = original;
    }

    seen = [];
    const failed = await syncLumaSettings(d1, "owner", "owner@test.local", ownerEnv(), {
      now: Date.now() + 120_000,
      fetchImpl: (async () => { throw new Error("down " + ICS); }) as typeof fetch,
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.view?.lastStatus, "error");
    assert.equal(failed.view?.lastError, LUMA_SYNC_ERROR);
    assert.equal(JSON.stringify(failed.view).includes(TOKEN), false);

    db.prepare("UPDATE luma_settings SET ics_cipher=NULL, ics_iv=NULL, ics_hint=NULL WHERE user_id='owner'").run();
    const fallbackSeen: string[] = [];
    const fallback = await syncLumaSettings(d1, "owner", "owner@test.local", ownerEnv({ LUMA_ICS_URL: ENV_ICS }), {
      now: Date.now() + 240_000,
      fetchImpl: (async (input: unknown) => {
        fallbackSeen.push(String(input));
        return new Response(feed(vevent(["UID:env", "SUMMARY:Env", "DTSTART:20261102T150000Z"])), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.view?.lastStatus, "ok");
    assert.equal(fallback.view?.envFallback, true);
    assert.deepEqual(fallbackSeen, [ENV_ICS]);
    assert.equal(JSON.stringify(fallback.view).includes(TOKEN), false);
    const listed = await readLumaSettings(d1, "owner", ownerEnv({ LUMA_ICS_URL: ENV_ICS }));
    assert.equal(listed.envFallback, true);
    assert.equal(listed.configured, false);

    await saveLumaLink(d1, "owner", ICS, ownerEnv(), 80);
    const noKey = await syncLumaSettings(d1, "owner", "owner@test.local", { MCP_OWNER_EMAIL: "owner@test.local" }, {
      now: Date.now() + 400_000,
      fetchImpl: (async () => { throw new Error("should not fetch"); }) as typeof fetch,
    });
    assert.equal(noKey.view?.lastStatus, "error");
    assert.equal(noKey.view?.lastError, LUMA_KEY_ERROR);
  });
});

test("the cron uses the saved link and falls back to the env secret", async () => {
  resetEncryptionModeCache();
  const { db, d1 } = openDb();
  person(db, "owner", "owner@luma.test");
  const saved = "https://api.lu.ma/ics/saved/" + TOKEN + "-save";
  const envUrl = "https://api.lu.ma/ics/server/" + TOKEN + "-serv";
  assert.equal((await saveLumaLink(d1, "owner", saved, { LUMA_SETTINGS_KEY: KEY }, 1)).ok, true);
  const seen: string[] = [];
  const okFetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(feed(), { status: 200 });
  }) as typeof fetch;
  const first = await runLumaSyncForOwner({ DB: d1, MCP_OWNER_EMAIL: "owner@luma.test", LUMA_ICS_URL: envUrl, LUMA_SETTINGS_KEY: KEY }, okFetch, new Date(NOW));
  assert.equal("view" in first && first.view?.lastStatus, "ok");
  assert.deepEqual(seen, [saved]);

  db.prepare("UPDATE luma_settings SET ics_cipher='not-cipher', ics_iv='not-iv', last_attempt_at=? WHERE user_id='owner'").run(Date.now());
  const fallbackSeen: string[] = [];
  const second = await runLumaSyncForOwner({ DB: d1, MCP_OWNER_EMAIL: "owner@luma.test", LUMA_ICS_URL: envUrl, LUMA_SETTINGS_KEY: KEY }, (async (input: unknown) => {
    fallbackSeen.push(String(input));
    return new Response(feed(vevent(["UID:srv", "SUMMARY:Server", "DTSTART:20261103T150000Z"])), { status: 200 });
  }) as typeof fetch, new Date(NOW + 10_000));
  assert.equal("view" in second && second.view?.lastStatus, "ok");
  assert.deepEqual(fallbackSeen, [envUrl]);

  db.prepare("UPDATE luma_settings SET ics_cipher=NULL, ics_iv=NULL, ics_hint=NULL WHERE user_id='owner'").run();
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const skipped = await runLumaSyncForOwner({ DB: d1, MCP_OWNER_EMAIL: "owner@luma.test", LUMA_SETTINGS_KEY: KEY }, okFetch, new Date(NOW));
    assert.equal("status" in skipped && skipped.status, 400);
    assert.equal((skipped as { error?: string }).error, LUMA_MISSING_ERROR);
    assert.deepEqual(logs, ["luma_sync_skipped"]);
  } finally {
    console.log = log;
  }
  assert.equal(LUMA_DECRYPT_ERROR.length > 0, true);
});

test("a local engine session gets 401 or 403 and does not read the secrets", async () => {
  await locked(async () => {
    resetEncryptionModeCache();
    const { db, d1 } = openDb();
    person(db, "member", "member@test.local", "user");
    person(db, "owner", "owner@test.local");
    const settings = await import("../app/api/settings/luma/route.ts");
    let reads = 0;
    const env = new Proxy({ DB: d1, MCP_OWNER_EMAIL: "owner@test.local" } as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === "LUMA_ICS_URL" || prop === "LUMA_SETTINGS_KEY") {
          reads += 1;
          return "https://api.lu.ma/ics/" + TOKEN;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const denied = await runWithEngineSession({
      userId: "member",
      db: d1,
      env,
      role: "user",
      email: "member@test.local",
      name: "member",
      approvalStatus: "approved",
    }, () => call(settings, "GET", "http://t.local/api/settings/luma"));
    assert.equal(denied.status, 403);
    assert.equal(JSON.stringify(denied.body).includes(TOKEN), false);
    assert.equal(reads, 0);

    const anon = await runWithEngineSession({
      userId: "member",
      db: d1,
      env,
      role: "admin",
      email: "member@test.local",
      approvalStatus: "pending",
    }, () => call(settings, "PUT", "http://t.local/api/settings/luma", { json: { url: ICS } }));
    assert.equal(anon.status, 401);
    assert.equal(reads, 0);

    db.exec("DROP TABLE luma_settings");
    const localAdmin = await runWithEngineSession({
      userId: "owner",
      db: d1,
      env,
      role: "admin",
      email: "owner@test.local",
      name: "owner",
      approvalStatus: "approved",
    }, () => call(settings, "GET", "http://t.local/api/settings/luma"));
    assert.equal(localAdmin.status, 200);
    assert.equal((localAdmin.body as { configured: boolean; envFallback: boolean }).configured, false);
    assert.equal((localAdmin.body as { envFallback: boolean }).envFallback, false);
    assert.equal(JSON.stringify(localAdmin.body).includes(TOKEN), false);
    assert.equal(reads, 0);
  });
});

test("the Luma settings UI uses pointer and not-allowed and never renders the saved link", () => {
  const ui = readFileSync(root + "app/luma-settings.tsx", "utf8");
  const css = readFileSync(root + "app/luma-settings.css", "utf8");
  const layout = readFileSync(root + "app/layout.tsx", "utf8");
  const workspace = readFileSync(root + "app/workspace.tsx", "utf8");
  const brand = readFileSync(root + "app/brand.css", "utf8");
  assert.match(css, /cursor:\s*pointer/);
  assert.match(css, /cursor:\s*not-allowed/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(ui, /Pegá el link ICS de tu calendario de Luma/);
  assert.match(ui, /Sincronizar ahora/);
  assert.match(ui, /Usando el link configurado en el servidor/);
  assert.match(ui, /Quitar borra solo el link guardado\. Los eventos ya importados se quedan\./);
  assert.match(ui, /El link es privado, se guarda cifrado y no se vuelve a mostrar\./);
  assert.match(ui, /En Luma abrí Settings \(Configuración\)\./);
  assert.match(ui, /Calendar Syncing \(Third Party Accounts\)/);
  assert.match(ui, /Add iCal Subscription/);
  assert.equal(ui.includes("ics_cipher"), false);
  assert.equal(ui.includes("dangerouslySetInnerHTML"), false);
  assert.deepEqual(ui.match(/https:\/\/[^)\s]*/g), ["https://api.lu.ma/ics/…"]);
  assert.match(layout, /import "\.\/luma-settings\.css"/);
  assert.match(workspace, /label:"Configuración",short:"Config"/);
  assert.match(workspace, /SectionIntro title="Configuración"/);
  assert.match(workspace, /<LumaSettings\/>/);
  assert.equal(workspace.includes('label:"Accesos"'), false);
  assert.equal(brand.includes("luma-settings"), false);
  assert.equal(brand.includes("luma-ics"), false);
});
