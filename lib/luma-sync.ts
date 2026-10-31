// Pull the owner's Luma calendar into luma_events. Never deletes. Never logs the URL.
import type { D1Bound, D1Like } from "./finance.ts";
import { parseLumaIcs, type IcsEvent } from "./luma-ics.ts";
import { buenosAiresDate } from "./luma-events.ts";
import { resolveOwner } from "./mailtox-link.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 3;

export type LumaSyncResult =
  | { status: "skipped" }
  | { status: "no_owner" }
  | { status: "skipped_e2e" }
  | { status: "rejected" }
  | { status: "ok"; inserted: number; updated: number };

const INSERT_SQL = "INSERT INTO luma_events (id,user_id,uid,name,starts_at,ends_at,url,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)";
const UPDATE_SQL = "UPDATE luma_events SET name=?,starts_at=?,ends_at=?,url=?,location=?,updated_at=? WHERE user_id=? AND uid=?";

type Existing = { uid: string; name: string; startsAt: string };

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  if (!response.body) {
    const text = await response.text();
    return text.length > MAX_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchIcs(url: string, fetchImpl: typeof fetch): Promise<string> {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!isHttps(current)) throw new Error("luma_ics_rejected");
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("luma_ics_rejected");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error("luma_ics_rejected");
    const text = await readCapped(response);
    if (text == null) throw new Error("luma_ics_rejected");
    return text;
  }
  throw new Error("luma_ics_rejected");
}

function dateKey(name: string, startsAt: string): string {
  return name.trim().toLowerCase() + "\n" + (buenosAiresDate(startsAt) ?? "");
}

function collapse(events: IcsEvent[]): IcsEvent[] {
  const byUid = new Map<string, IcsEvent>();
  for (const event of events) byUid.set(event.uid, event);
  return [...byUid.values()];
}

/**
 * Fetch `icsUrl` (https only, 8s, 2 MB, redirects must stay https) and upsert luma_events for the owner.
 * Owner is `MCP_OWNER_EMAIL`: admin, approved, and not an e2e account (same gate as resolveOwner).
 * Keyed by (user_id, uid). A new uid whose lower(name) and Buenos Aires date already exist is skipped.
 * Rows are never deleted. A missing URL logs `luma_sync_skipped` and does nothing. The URL is never logged.
 */
export async function syncLumaEvents(db: D1Like, ownerEmail: string | undefined, icsUrl: string | undefined, fetchImpl: typeof fetch, now: Date = new Date()): Promise<LumaSyncResult> {
  const url = typeof icsUrl === "string" ? icsUrl.trim() : "";
  if (!url) {
    console.log("luma_sync_skipped");
    return { status: "skipped" };
  }
  const owner = await resolveOwner(db, ownerEmail);
  if (!owner.ok) return { status: owner.status };
  if (!isHttps(url)) return { status: "rejected" };

  let text: string;
  try {
    text = await fetchIcs(url, fetchImpl);
  } catch {
    console.error("luma_sync_failed");
    return { status: "rejected" };
  }

  const events = collapse(parseLumaIcs(text, now.getTime()));
  const existing = (await db.prepare("SELECT uid, name, starts_at AS startsAt FROM luma_events WHERE user_id=?").bind(owner.userId).all<Existing>()).results ?? [];
  const known = new Set(existing.map((row) => String(row.uid)));
  const nameDates = new Set(existing.map((row) => dateKey(String(row.name), String(row.startsAt))));
  const statements: D1Bound[] = [];
  let inserted = 0;
  let updated = 0;
  const stamp = Date.now();

  for (const event of events) {
    if (known.has(event.uid)) {
      statements.push(db.prepare(UPDATE_SQL).bind(event.name, event.startsAt, event.endsAt, event.url, event.location, stamp, owner.userId, event.uid));
      updated++;
      continue;
    }
    const key = dateKey(event.name, event.startsAt);
    if (nameDates.has(key)) continue;
    nameDates.add(key);
    known.add(event.uid);
    statements.push(db.prepare(INSERT_SQL).bind(crypto.randomUUID(), owner.userId, event.uid, event.name, event.startsAt, event.endsAt, event.url, event.location, stamp, stamp));
    inserted++;
  }

  if (statements.length > 0) {
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await statement.run();
  }
  return { status: "ok", inserted, updated };
}
