// Stale-while-revalidate snapshots of list/view responses.
// Keys are `serpix:swr:<userId>:<endpoint>`. Settings, the Luma link, auth,
// passwords, tokens and other sensitive routes are refused. Logout deletes
// every `serpix:swr:` key. A different signed-in user deletes them too.
// Encrypted sessions must not call read/write: that plaintext stays in memory.

export const SWR_PREFIX = "serpix:swr:";
const USER_KEY = SWR_PREFIX + "uid";

export const swrPaths = {
  contacts: "/api/data/contacts",
  projects: "/api/data/projects",
  tasks: "/api/data/tasks",
  accounts: "/api/data/accounts",
  activities: "/api/data/activities",
  totals: "/api/finance/totals",
  inquiries: "/api/inquiries",
  recurring: "/api/recurring",
  lumaEvents: "/api/luma-events",
  documents: "/api/documents",
  timeEntries: "/api/time-entries",
  adminUsers: "/api/admin/users",
  invites: "/api/admin/invites",
} as const;

const LIST_PATHS = new Set<string>(Object.values(swrPaths));

export function transactionsPath(limit: number): string {
  return "/api/data/transactions?limit=" + limit;
}

/** True only for list/view endpoints. Settings, Luma link, auth and secrets are false. */
export function swrCacheable(endpoint: string): boolean {
  if (typeof endpoint !== "string" || !endpoint.startsWith("/api/")) return false;
  const lower = endpoint.toLowerCase();
  if (
    lower.includes("password") || lower.includes("token") || lower.includes("secret") ||
    lower.includes("/api/auth") || lower.includes("/api/settings") || lower.includes("/api/e2e") ||
    lower.includes("/api/push") || lower.includes("/api/invites")
  ) return false;
  if (/^\/api\/data\/transactions\?limit=\d+$/.test(endpoint)) return true;
  if (endpoint.includes("?") || endpoint.includes("#")) return false;
  return LIST_PATHS.has(endpoint);
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function cacheKey(userId: string, endpoint: string): string {
  return SWR_PREFIX + userId + ":" + endpoint;
}

function foreignKeys(ls: Storage, userId: string): boolean {
  const own = SWR_PREFIX + userId + ":";
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(SWR_PREFIX) || key === USER_KEY) continue;
    if (!key.startsWith(own)) return true;
  }
  return false;
}

/** Deletes every `serpix:swr:` entry, including the stored user id. */
export function clearSwrCache(): void {
  const ls = storage();
  if (!ls) return;
  const drop: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (key && key.startsWith(SWR_PREFIX)) drop.push(key);
  }
  for (const key of drop) ls.removeItem(key);
}

/** Remember `userId`. If the stored id differs, or leftover keys belong to someone else, wipe first. */
export function bindSwrUser(userId: string): void {
  const ls = storage();
  if (!ls || !userId) return;
  const stored = ls.getItem(USER_KEY);
  if (stored !== userId && (stored !== null || foreignKeys(ls, userId))) clearSwrCache();
  try { ls.setItem(USER_KEY, userId); } catch { /* private mode */ }
}

export function readSwr<T>(userId: string, endpoint: string): T | null {
  if (!userId || !swrCacheable(endpoint)) return null;
  const ls = storage();
  if (!ls) return null;
  bindSwrUser(userId);
  try {
    const raw = ls.getItem(cacheKey(userId, endpoint));
    if (!raw) return null;
    const value = JSON.parse(raw) as T;
    if (!value || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

export function writeSwr(userId: string, endpoint: string, value: unknown): void {
  if (!userId || !swrCacheable(endpoint) || value === undefined) return;
  const ls = storage();
  if (!ls) return;
  bindSwrUser(userId);
  try {
    const raw = JSON.stringify(value);
    if (!raw) return;
    ls.setItem(cacheKey(userId, endpoint), raw);
  } catch { /* quota or private mode */ }
}
