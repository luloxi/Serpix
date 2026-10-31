// Pure timer math. No "@/…" imports: node --test loads this file directly.
// Elapsed time is always derived from timestamps, never from a tick counter.

export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 7 * 86_400_000;
export const ROUND_STEP_MS = 15 * 60_000;
export const NUDGE_MS = 5 * 60_000;
export const MAX_HOURLY_RATE_MINOR = 1_000_000_000;
export const MAX_DESCRIPTION = 2000;

const TZ = "America/Buenos_Aires";

export type TimerState = {
  startedAt: number;
  segmentStart: number | null;
  accumulatedMs: number;
};

export type TimeEntryInput = {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  taskId: string | null;
  billable: boolean;
  hourlyRateMinor: number;
  description: string | null;
  fromTimer: boolean;
};

export function startTimer(now: number): TimerState {
  return { startedAt: now, segmentStart: now, accumulatedMs: 0 };
}

/** elapsed = accumulatedMs + (segmentStart ? now - segmentStart : 0), never negative. */
export function elapsedMs(timer: Pick<TimerState, "accumulatedMs" | "segmentStart">, now: number): number {
  const running = timer.segmentStart == null ? 0 : now - timer.segmentStart;
  const total = timer.accumulatedMs + running;
  return total > 0 ? total : 0;
}

/** Pause: fold the open segment into accumulatedMs. No-op when already paused. */
export function pauseTimer(timer: TimerState, now: number): TimerState {
  if (timer.segmentStart == null) return timer;
  return { startedAt: timer.startedAt, segmentStart: null, accumulatedMs: elapsedMs(timer, now) };
}

/** Resume: open a segment at `now`. No-op when already running. */
export function resumeTimer(timer: TimerState, now: number): TimerState {
  if (timer.segmentStart != null) return timer;
  return { startedAt: timer.startedAt, segmentStart: now, accumulatedMs: timer.accumulatedMs };
}

/** serverNow - clientNow. Add this to Date.now() so elapsed matches the server clock. */
export function clockSkew(serverNow: number, clientNow: number): number {
  return serverNow - clientNow;
}

export function adjustedNow(clientNow: number, skewMs: number): number {
  return clientNow + skewMs;
}

export function parseTimerState(value: unknown): TimerState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isInt(v.startedAt) || !isInt(v.accumulatedMs) || v.accumulatedMs < 0) return null;
  if (v.segmentStart != null && !isInt(v.segmentStart)) return null;
  return { startedAt: v.startedAt, segmentStart: v.segmentStart == null ? null : v.segmentStart, accumulatedMs: v.accumulatedMs };
}

/** Round a duration UP to the next 15 minutes. Exact multiples stay. Never below 1 minute or above 7 days. */
export function roundUpDuration(durationMs: number): number {
  const base = Math.max(MIN_DURATION_MS, Number.isFinite(durationMs) ? durationMs : MIN_DURATION_MS);
  const rounded = Math.ceil(base / ROUND_STEP_MS) * ROUND_STEP_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, rounded));
}

/** ±5 min (or any delta) moves the end. Duration stays inside [1 minute, 7 days]. */
export function nudgeEnd(startedAt: number, endedAt: number, deltaMs: number): number {
  const duration = endedAt - startedAt + deltaMs;
  const clamped = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, duration));
  return startedAt + clamped;
}

export function roundUpEnd(startedAt: number, endedAt: number): number {
  return startedAt + roundUpDuration(endedAt - startedAt);
}

/** Default entry window: start stays the timer start; length is the active time snapped down to a whole minute, at least 1. */
export function initialEntryWindow(startedAt: number, activeMs: number): { startedAt: number; endedAt: number; durationMs: number } {
  const whole = Math.floor(Math.max(0, activeMs) / MIN_DURATION_MS) * MIN_DURATION_MS;
  const durationMs = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, whole));
  return { startedAt, endedAt: startedAt + durationMs, durationMs };
}

export function applyStartInput(endedAt: number, input: string): { startedAt: number; endedAt: number } | null {
  const startedAt = localInputToEpoch(input);
  if (startedAt == null) return null;
  const duration = endedAt - startedAt;
  if (duration < MIN_DURATION_MS) return { startedAt, endedAt: startedAt + MIN_DURATION_MS };
  if (duration > MAX_DURATION_MS) return { startedAt, endedAt: startedAt + MAX_DURATION_MS };
  return { startedAt, endedAt };
}

export function applyEndInput(startedAt: number, input: string): number | null {
  const endedAt = localInputToEpoch(input);
  if (endedAt == null) return null;
  const duration = endedAt - startedAt;
  if (duration < MIN_DURATION_MS) return startedAt + MIN_DURATION_MS;
  if (duration > MAX_DURATION_MS) return startedAt + MAX_DURATION_MS;
  return endedAt;
}

/** amount_minor = billable ? round(durationMs / 3_600_000 * hourlyRateMinor) : 0 */
export function entryAmountMinor(durationMs: number, hourlyRateMinor: number, billable: boolean): number {
  if (!billable) return 0;
  return Math.round(durationMs / 3_600_000 * hourlyRateMinor);
}

export function formatHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatHM(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const m = total % 60;
  const h = Math.floor(total / 60);
  return `${pad(h)}:${pad(m)}`;
}

/** "1h 20m", "2h", "20m", "0m". Whole minutes, floored. */
export function formatTracked(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const m = total % 60;
  const h = Math.floor(total / 60);
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function parseTimeEntryBody(body: unknown): { ok: true; value: TimeEntryInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Datos inválidos" };
  const b = body as Record<string, unknown>;
  if (!isInt(b.startedAt) || !isInt(b.endedAt) || !isInt(b.durationMs) || !isInt(b.hourlyRateMinor)) {
    return { ok: false, error: "Los tiempos y la tarifa tienen que ser números enteros" };
  }
  if (b.endedAt <= b.startedAt) return { ok: false, error: "La hora de fin tiene que ser posterior al inicio" };
  if (b.durationMs < MIN_DURATION_MS || b.durationMs > MAX_DURATION_MS) return { ok: false, error: "La duración tiene que ser de 1 minuto a 7 días" };
  if (b.hourlyRateMinor < 0 || b.hourlyRateMinor > MAX_HOURLY_RATE_MINOR) return { ok: false, error: "La tarifa por hora no es válida" };
  if (typeof b.billable !== "boolean") return { ok: false, error: "Facturable tiene que ser sí o no" };
  let description: string | null = null;
  if (b.description != null && b.description !== "") {
    if (typeof b.description !== "string") return { ok: false, error: "La descripción no es válida" };
    if (b.description.length > MAX_DESCRIPTION) return { ok: false, error: "La descripción puede tener hasta 2000 caracteres" };
    const trimmed = b.description.trim();
    description = trimmed ? trimmed : null;
  }
  let taskId: string | null = null;
  if (b.taskId != null && b.taskId !== "") {
    if (typeof b.taskId !== "string") return { ok: false, error: "La tarea no es válida" };
    const id = b.taskId.trim();
    if (!id || id.length > 80) return { ok: false, error: "La tarea no es válida" };
    taskId = id;
  }
  let fromTimer = false;
  if (b.fromTimer != null) {
    if (typeof b.fromTimer !== "boolean") return { ok: false, error: "fromTimer tiene que ser sí o no" };
    fromTimer = b.fromTimer;
  }
  return { ok: true, value: { startedAt: b.startedAt, endedAt: b.endedAt, durationMs: b.durationMs, taskId, billable: b.billable, hourlyRateMinor: b.hourlyRateMinor, description, fromTimer } };
}

/** Epoch ms → "YYYY-MM-DDTHH:MM" in America/Buenos_Aires (no seconds). */
export function epochToLocalInput(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const p = partsInZone(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DDTHH:MM" interpreted as America/Buenos_Aires → epoch ms. Invalid calendar dates return null. */
export function localInputToEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]), minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = wall - zoneOffsetMs(wall);
  utc = wall - zoneOffsetMs(utc);
  if (epochToLocalInput(utc) !== value) return null;
  return utc;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function pad(n: number): string {
  return String(Math.trunc(n)).padStart(2, "0");
}

function partsInZone(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  let year = get("year"), month = get("month"), day = get("day"), hour = get("hour");
  // Some ICU builds report midnight as hour 24 of the previous day.
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return { year, month, day, hour, minute: get("minute"), second: get("second") };
}

function zoneOffsetMs(utcMs: number): number {
  const p = partsInZone(utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}
