// Owner Luma ICS link: encrypt, remember sync status, and run the cron/button sync.
// The plaintext link is never returned and never logged.
import type { D1Like } from "./finance.ts";
import { decryptLumaUrl, encryptLumaUrl, LUMA_KEY_ERROR } from "./luma-secret.ts";
import { syncLumaEvents } from "./luma-sync.ts";
import { lumaHint, LUMA_SYNC_ERROR, LUMA_URL_ERROR, normalizeLumaUrl, publicSyncError } from "./luma-url.ts";
import { resolveOwner } from "./mailtox-link.ts";

export const LUMA_RATE_LIMIT_ERROR = "Esperá un minuto para volver a sincronizar.";
export const LUMA_MISSING_ERROR = "No hay un link de Luma configurado";
export const LUMA_DECRYPT_ERROR = "No se pudo leer el link guardado";
const RATE_MS = 60_000;

const SELECT_SQL = "SELECT ics_cipher, ics_iv, ics_hint, saved_at, last_attempt_at, last_sync_at, last_status, last_count, last_error FROM luma_settings WHERE user_id=?";

export type LumaSettingsView = {
  configured: boolean;
  hint: string | null;
  savedAt: number | null;
  envFallback: boolean;
  lastAttemptAt: number | null;
  lastSyncAt: number | null;
  lastStatus: string | null;
  lastCount: number | null;
  lastError: string | null;
};

export const EMPTY_LUMA_SETTINGS: LumaSettingsView = {
  configured: false,
  hint: null,
  savedAt: null,
  envFallback: false,
  lastAttemptAt: null,
  lastSyncAt: null,
  lastStatus: null,
  lastCount: null,
  lastError: null,
};

export type LumaSettingsEnv = {
  LUMA_ICS_URL?: string;
  LUMA_SETTINGS_KEY?: string;
  MCP_OWNER_EMAIL?: string;
};

export type LumaCronEnv = LumaSettingsEnv & { DB: D1Like };

type SettingsRow = {
  ics_cipher: string | null;
  ics_iv: string | null;
  ics_hint: string | null;
  saved_at: number | null;
  last_attempt_at: number | null;
  last_sync_at: number | null;
  last_status: string | null;
  last_count: number | null;
  last_error: string | null;
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function envHasLumaUrl(env: LumaSettingsEnv): boolean {
  return typeof env.LUMA_ICS_URL === "string" && env.LUMA_ICS_URL.trim() !== "";
}

function publicHint(value: unknown): string | null {
  const hint = text(value);
  if (!hint || hint.length > 280 || hint.includes("://") || /\s/.test(hint)) return null;
  return hint;
}

function toView(row: SettingsRow | null, env: LumaSettingsEnv): LumaSettingsView {
  if (!row) return { ...EMPTY_LUMA_SETTINGS, envFallback: envHasLumaUrl(env) };
  const cipher = text(row.ics_cipher);
  const iv = text(row.ics_iv);
  return {
    configured: Boolean(cipher && iv),
    hint: cipher && iv ? publicHint(row.ics_hint) : null,
    savedAt: num(row.saved_at),
    envFallback: envHasLumaUrl(env),
    lastAttemptAt: num(row.last_attempt_at),
    lastSyncAt: num(row.last_sync_at),
    lastStatus: text(row.last_status),
    lastCount: num(row.last_count),
    lastError: text(row.last_error),
  };
}

export async function lumaSettingsTable(db: D1Like): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'luma_settings'").bind().first<{ n: number }>();
  return row != null;
}

/** When MCP_OWNER_EMAIL is set, only that owner may read or write the row. */
export async function lumaOwnerAllowed(db: D1Like, userId: string, ownerEmail: string | undefined): Promise<boolean> {
  if (typeof ownerEmail !== "string" || !ownerEmail.trim()) return true;
  const owner = await resolveOwner(db, ownerEmail);
  return owner.ok && owner.userId === userId;
}

async function loadRow(db: D1Like, userId: string): Promise<SettingsRow | null> {
  return db.prepare(SELECT_SQL).bind(userId).first<SettingsRow>();
}

export async function readLumaSettings(db: D1Like, userId: string, env: LumaSettingsEnv): Promise<LumaSettingsView> {
  return toView(await loadRow(db, userId), env);
}

export async function saveLumaLink(db: D1Like, userId: string, rawUrl: unknown, env: LumaSettingsEnv, now = Date.now()): Promise<{ ok: true; view: LumaSettingsView } | { ok: false; error: string; status: number }> {
  const url = normalizeLumaUrl(rawUrl);
  if (!url) return { ok: false, error: LUMA_URL_ERROR, status: 400 };
  let sealed: { cipher: string; iv: string };
  try {
    sealed = await encryptLumaUrl(url, userId, env.LUMA_SETTINGS_KEY);
  } catch (error) {
    const message = error instanceof Error && error.message === LUMA_KEY_ERROR ? LUMA_KEY_ERROR : LUMA_KEY_ERROR;
    return { ok: false, error: message, status: 500 };
  }
  const hint = lumaHint(url);
  await db.prepare(
    "INSERT INTO luma_settings (user_id, ics_cipher, ics_iv, ics_hint, saved_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET ics_cipher=excluded.ics_cipher, ics_iv=excluded.ics_iv, ics_hint=excluded.ics_hint, saved_at=excluded.saved_at, updated_at=excluded.updated_at",
  ).bind(userId, sealed.cipher, sealed.iv, hint, now, now).run();
  return { ok: true, view: await readLumaSettings(db, userId, env) };
}

/** Clears the saved link only. The status row and every luma_events row stay. */
export async function clearLumaLink(db: D1Like, userId: string, env: LumaSettingsEnv, now = Date.now()): Promise<LumaSettingsView> {
  await db.prepare("UPDATE luma_settings SET ics_cipher=NULL, ics_iv=NULL, ics_hint=NULL, updated_at=? WHERE user_id=?").bind(now, userId).run();
  return readLumaSettings(db, userId, env);
}

async function writeStatus(db: D1Like, userId: string, env: LumaSettingsEnv, patch: { now: number; ok: boolean; error: string | null; count: number | null }): Promise<LumaSettingsView> {
  await db.prepare(
    "INSERT INTO luma_settings (user_id, last_attempt_at, last_sync_at, last_status, last_count, last_error, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_sync_at=COALESCE(excluded.last_sync_at, luma_settings.last_sync_at), last_status=excluded.last_status, last_count=COALESCE(excluded.last_count, luma_settings.last_count), last_error=excluded.last_error, updated_at=excluded.updated_at",
  ).bind(
    userId,
    patch.now,
    patch.ok ? patch.now : null,
    patch.ok ? "ok" : "error",
    patch.ok ? patch.count : null,
    patch.ok ? null : patch.error,
    patch.now,
  ).run();
  return readLumaSettings(db, userId, env);
}

export type LumaSyncCall = {
  status: number;
  view?: LumaSettingsView;
  error?: string;
};

/**
 * Sync this user's saved link, or LUMA_ICS_URL when there is no saved link or it cannot be decrypted.
 * `rateLimit` rejects a second attempt inside 60s (the button). The cron leaves it off.
 */
export async function syncLumaSettings(
  db: D1Like,
  userId: string,
  ownerEmail: string,
  env: LumaSettingsEnv,
  opts: { rateLimit?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<LumaSyncCall> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const row = await loadRow(db, userId);
  const attempted = num(row?.last_attempt_at);
  if (opts.rateLimit && attempted != null && now - attempted < RATE_MS) {
    return { status: 429, error: LUMA_RATE_LIMIT_ERROR, view: toView(row, env) };
  }

  let url: string | null = null;
  let failure: string | null = null;
  if (text(row?.ics_cipher) && text(row?.ics_iv)) {
    try {
      const plain = await decryptLumaUrl(String(row?.ics_cipher), String(row?.ics_iv), userId, env.LUMA_SETTINGS_KEY);
      url = normalizeLumaUrl(plain);
      if (!url) failure = LUMA_URL_ERROR;
    } catch (error) {
      failure = error instanceof Error && error.message === LUMA_KEY_ERROR ? LUMA_KEY_ERROR : LUMA_DECRYPT_ERROR;
    }
  }

  if (!url) {
    const fallback = normalizeLumaUrl(typeof env.LUMA_ICS_URL === "string" ? env.LUMA_ICS_URL : "");
    if (fallback) url = fallback;
    else if (failure) return { status: 200, view: await writeStatus(db, userId, env, { now, ok: false, error: failure, count: null }) };
    else {
      console.log("luma_sync_skipped");
      return { status: 400, error: LUMA_MISSING_ERROR, view: toView(row, env) };
    }
  }

  let rejectMessage = LUMA_SYNC_ERROR;
  let result: Awaited<ReturnType<typeof syncLumaEvents>>;
  try {
    result = await syncLumaEvents(db, ownerEmail, url, fetchImpl, new Date(now), (message) => {
      rejectMessage = message;
    });
  } catch (error) {
    console.error("luma_sync_failed");
    const safe = publicSyncError(error, [url]);
    return { status: 200, view: await writeStatus(db, userId, env, { now, ok: false, error: safe, count: null }) };
  }

  if (result.status === "ok") {
    return { status: 200, view: await writeStatus(db, userId, env, { now, ok: true, error: null, count: result.inserted + result.updated }) };
  }
  if (result.status === "skipped") {
    console.log("luma_sync_skipped");
    return { status: 400, error: LUMA_MISSING_ERROR, view: toView(row, env) };
  }
  const message = result.status === "rejected" ? rejectMessage : result.status === "skipped_e2e" ? "La cuenta está cifrada" : "No se pudo sincronizar";
  return { status: 200, view: await writeStatus(db, userId, env, { now, ok: false, error: message, count: null }) };
}

/**
 * Cron entry for both schedules. Saved link first, then LUMA_ICS_URL.
 * A decrypt failure is recorded and, when the env secret is set, the sync still runs with it.
 * No 60s limit. A missing link logs luma_sync_skipped.
 */
export async function runLumaSyncForOwner(env: LumaCronEnv, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<LumaSyncCall | { status: "no_owner" } | { status: "skipped_e2e" } | { status: "skipped" }> {
  try {
    const owner = await resolveOwner(env.DB, env.MCP_OWNER_EMAIL);
    if (!owner.ok) {
      if (!envHasLumaUrl(env)) {
        console.log("luma_sync_skipped");
        return { status: "skipped" };
      }
      await syncLumaEvents(env.DB, env.MCP_OWNER_EMAIL, env.LUMA_ICS_URL, fetchImpl, now);
      return { status: owner.status };
    }
    return syncLumaSettings(env.DB, owner.userId, env.MCP_OWNER_EMAIL ?? "", env, { rateLimit: false, fetchImpl, now: now.getTime() });
  } catch (error) {
    console.error("luma_sync_failed");
    void publicSyncError(error, [typeof env.LUMA_ICS_URL === "string" ? env.LUMA_ICS_URL : ""]);
    return { status: "skipped" };
  }
}
