// One-pass RFC 5545 reader for a Luma ICS feed. VEVENT only; RRULE and EXDATE are not expanded.

import { buenosAiresDate } from "./luma-events.ts";

const MAX_ICS_CHARS = 2 * 1024 * 1024;
const MAX_LINE = 16_000;
const MAX_EVENTS = 300;
const DAY_MS = 86_400_000;
const PAST_MS = 14 * DAY_MS;
const FUTURE_MS = 180 * DAY_MS;
const BA = "America/Buenos_Aires";

const NAME_MAX = 500;
const UID_MAX = 500;
const URL_MAX = 2000;
const LOCATION_MAX = 500;

export type IcsEvent = {
  uid: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  url: string | null;
  location: string | null;
};

type Stamp = { iso: string; allDay: boolean };

type Draft = {
  uid: string;
  name: string;
  start: Stamp | null;
  end: Stamp | null;
  url: string | null;
  location: string | null;
  cancelled: boolean;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const created = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, created);
    return created;
  } catch {
    return null;
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  for (const item of parts) if (item.type === type) return Number(item.value);
  return NaN;
}

/** Wall clock in `timeZone` to UTC ISO. Null when the zone is unknown or the date is impossible. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): string | null {
  if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const fmt = formatter(timeZone);
  if (!fmt) return null;
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = desired;
  for (let step = 0; step < 4; step++) {
    const parts = fmt.formatToParts(new Date(utc));
    const y = part(parts, "year");
    const mo = part(parts, "month");
    const d = part(parts, "day");
    let h = part(parts, "hour");
    const mi = part(parts, "minute");
    const s = part(parts, "second");
    if (h === 24) h = 0;
    if (!validYmd(y, mo, d)) return null;
    const got = Date.UTC(y, mo - 1, d, h, mi, s);
    const diff = got - desired;
    if (diff === 0) return new Date(utc).toISOString();
    utc -= diff;
  }
  return new Date(utc).toISOString();
}

function validYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last;
}

function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch !== 92) {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += "\\";
      break;
    }
    i++;
    if (next === "n" || next === "N") out += "\n";
    else out += next;
  }
  return out;
}

function splitProp(line: string): { name: string; params: Map<string, string>; value: string } | null {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ":" || ch === ";") break;
    i++;
  }
  if (i === 0 || i >= line.length) return null;
  const name = line.slice(0, i).toUpperCase();
  let params = "";
  if (line[i] === ";") {
    const colon = unquotedColon(line, i);
    if (colon < 0) return null;
    params = line.slice(i, colon);
    i = colon;
  }
  if (line[i] !== ":") return null;
  return { name, params: parseParams(params), value: line.slice(i + 1) };
}

function unquotedColon(line: string, from: number): number {
  let quoted = false;
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

function parseParams(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === ";") i++;
    const eq = raw.indexOf("=", i);
    if (eq < 0) break;
    const key = raw.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value = "";
    if (raw[i] === '"') {
      i++;
      const end = raw.indexOf('"', i);
      if (end < 0) {
        value = raw.slice(i);
        i = raw.length;
      } else {
        value = raw.slice(i, end);
        i = end + 1;
      }
    } else {
      const next = raw.indexOf(";", i);
      if (next < 0) {
        value = raw.slice(i);
        i = raw.length;
      } else {
        value = raw.slice(i, next);
        i = next;
      }
    }
    if (key) params.set(key, value);
  }
  return params;
}

function digits(value: string, from: number, length: number): number | null {
  if (from + length > value.length) return null;
  let n = 0;
  for (let i = 0; i < length; i++) {
    const code = value.charCodeAt(from + i);
    if (code < 48 || code > 57) return null;
    n = n * 10 + (code - 48);
  }
  return n;
}

function parseStamp(raw: string, params: Map<string, string>): Stamp | null {
  const value = raw.trim();
  if (value.length < 8) return null;
  const year = digits(value, 0, 4);
  const month = digits(value, 4, 2);
  const day = digits(value, 6, 2);
  if (year === null || month === null || day === null || !validYmd(year, month, day)) return null;
  const allDay = (params.get("VALUE") ?? "").toUpperCase() === "DATE" || value.length === 8;
  if (allDay) {
    const iso = zonedToUtc(year, month, day, 0, 0, 0, BA);
    return iso ? { iso, allDay: true } : null;
  }
  if (value[8] !== "T") return null;
  const hour = digits(value, 9, 2);
  const minute = digits(value, 11, 2);
  if (hour === null || minute === null) return null;
  let second = 0;
  let idx = 13;
  const maybeSecond = digits(value, 13, 2);
  if (maybeSecond !== null) {
    second = maybeSecond;
    idx = 15;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const tail = value.slice(idx);
  if (tail === "Z" || tail === "z") {
    return { iso: new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString(), allDay: false };
  }
  if (tail !== "") return null;
  const zone = params.get("TZID") || BA;
  const iso = zonedToUtc(year, month, day, hour, minute, second, zone);
  return iso ? { iso, allDay: false } : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function accept(draft: Draft, nowMs: number, out: IcsEvent[]) {
  if (out.length >= MAX_EVENTS || draft.cancelled) return;
  const uid = clip(draft.uid.trim(), UID_MAX);
  const name = clip(draft.name.trim(), NAME_MAX);
  if (!uid || !name || !draft.start) return;
  const startsAt = draft.start.iso;
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs) || startMs < nowMs - PAST_MS || startMs > nowMs + FUTURE_MS) return;
  let endsAt: string | null = null;
  if (draft.end) endsAt = draft.end.iso;
  else if (draft.start.allDay) endsAt = new Date(startMs + DAY_MS).toISOString();
  out.push({
    uid,
    name,
    startsAt,
    endsAt,
    url: draft.url ? clip(draft.url.trim(), URL_MAX) || null : null,
    location: draft.location ? clip(draft.location.trim(), LOCATION_MAX) || null : null,
  });
}

function applyProp(draft: Draft, name: string, params: Map<string, string>, value: string) {
  if (name === "UID") draft.uid = unescapeText(value);
  else if (name === "SUMMARY") draft.name = unescapeText(value);
  else if (name === "DTSTART") draft.start = parseStamp(value, params);
  else if (name === "DTEND") draft.end = parseStamp(value, params);
  else if (name === "LOCATION") draft.location = unescapeText(value);
  else if (name === "URL") draft.url = unescapeText(value);
  else if (name === "STATUS" && unescapeText(value).trim().toUpperCase() === "CANCELLED") draft.cancelled = true;
}

/**
 * VEVENT rows whose DTSTART falls in `[now-14d, now+180d]`, at most 300.
 * Folded lines are joined. CANCELLED is skipped. RRULE and EXDATE are ignored.
 * Z is UTC, TZID and floating times become UTC (floating means Buenos Aires), VALUE=DATE is that calendar day at Buenos Aires midnight.
 */
export function parseLumaIcs(text: string, nowMs: number): IcsEvent[] {
  const src = text.length > MAX_ICS_CHARS ? text.slice(0, MAX_ICS_CHARS) : text;
  const out: IcsEvent[] = [];
  let vevent = 0;
  let draft: Draft | null = null;
  let logical = "";
  let i = 0;
  const n = src.length;

  const handle = (raw: string) => {
    if (!raw) return;
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const prop = splitProp(line);
    if (!prop) return;
    if (prop.name === "BEGIN") {
      const kind = prop.value.trim().toUpperCase();
      if (kind === "VEVENT" && vevent === 0) {
        vevent = 1;
        draft = { uid: "", name: "", start: null, end: null, url: null, location: null, cancelled: false };
      } else if (vevent > 0) vevent++;
      return;
    }
    if (prop.name === "END") {
      if (vevent === 1 && prop.value.trim().toUpperCase() === "VEVENT") {
        if (draft) accept(draft, nowMs, out);
        vevent = 0;
        draft = null;
      } else if (vevent > 0) vevent--;
      return;
    }
    if (vevent === 1 && draft) applyProp(draft, prop.name, prop.params, prop.value);
  };

  while (i < n) {
    if (out.length >= MAX_EVENTS && vevent === 0) break;
    let end = i;
    while (end < n && src.charCodeAt(end) !== 10 && src.charCodeAt(end) !== 13) end++;
    const raw = src.slice(i, end);
    if (src.charCodeAt(end) === 13) end++;
    if (src.charCodeAt(end) === 10) end++;
    i = end;
    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      logical += raw.slice(1);
      if (logical.length > MAX_LINE) logical = logical.slice(0, MAX_LINE);
      continue;
    }
    if (logical) handle(logical);
    logical = raw;
  }
  if (logical && (out.length < MAX_EVENTS || vevent > 0)) handle(logical);
  return out;
}

/** Exposed so a sync dedupe and a test can share the calendar day of a parsed start. */
export function icsEventDate(startsAt: string): string | null {
  return buenosAiresDate(startsAt);
}
