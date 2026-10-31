// Which Luma events stay in the suggestion list. Pure: no database and no fetch.

const BA = "America/Buenos_Aires";
const DAY_MS = 86_400_000;

/** Still a suggestion until this long after the event ends (or starts, if it has no end). */
export const LUMA_VISIBLE_MS = 7 * DAY_MS;

export type LumaVisibilityEvent = {
  name: string;
  startsAt: string;
  endsAt: string | null;
  userId: string;
};

export type LumaVisibilityContact = {
  userId: string;
  metEvent: string | null | undefined;
};

/** YYYY-MM-DD in America/Buenos_Aires. Null when `iso` is not a real instant. */
export function buenosAiresDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: BA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : null;
}

/**
 * Visible while `now <= (endsAt ?? startsAt) + 7 days` (the instant equal to that boundary still counts).
 * After that, only a contact of the same user whose trimmed metEvent matches the name, case-insensitive, keeps it.
 * Another user's contact does not. Nothing here deletes a row.
 */
export function eventSuggestionVisible(event: LumaVisibilityEvent, contacts: readonly LumaVisibilityContact[], now: number): boolean {
  const endRaw = event.endsAt && event.endsAt.trim() ? event.endsAt : event.startsAt;
  const endMs = Date.parse(endRaw);
  if (Number.isFinite(endMs) && now <= endMs + LUMA_VISIBLE_MS) return true;
  const name = event.name.trim().toLowerCase();
  if (!name) return false;
  for (const contact of contacts) {
    if (contact.userId !== event.userId) continue;
    const used = (contact.metEvent ?? "").trim().toLowerCase();
    if (used && used === name) return true;
  }
  return false;
}
