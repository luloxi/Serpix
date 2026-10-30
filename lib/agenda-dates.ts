// Date helpers for the agenda. "Today" is always the calendar day in America/Buenos_Aires.
const TZ = "America/Buenos_Aires";
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export const todayBA = (now: Date = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(now);

/** YYYY-MM-DD plus n days (calendar arithmetic in UTC, no DST surprises). */
export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "Octubre" for the current year, "Octubre 2027" otherwise. */
export function monthLabel(day: string, today: string): string {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1;
  return MONTHS[m] + (y === Number(today.slice(0, 4)) ? "" : " " + y);
}

/** "Vie 30", prefixed with "Hoy · " / "Mañana · " when it applies. The month is NOT repeated. */
export function dayChip(day: string, today: string): string {
  const d = new Date(day + "T12:00:00Z");
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
  if (day === today) return "Hoy · " + base;
  if (day === addDays(today, 1)) return "Mañana · " + base;
  return base;
}

/** "28 oct" for rows that are not under a day heading (overdue). */
export const shortDate = (day: string) => { const d = new Date(day + "T12:00:00Z"); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3).toLowerCase()}`; };
