// Shared Luma ICS URL check: save, sync, and every redirect hop. Never logs the URL.

export const LUMA_URL_ERROR = "Solo links de Luma (lu.ma o luma.com)";
export const LUMA_SYNC_ERROR = "No se pudo leer el calendario de Luma";
export const MAX_LUMA_URL_LENGTH = 2000;

const ROOTS = ["lu.ma", "luma.com"];

function lumaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("..") || host.startsWith(".") || host.endsWith(".")) return false;
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  for (const root of ROOTS) {
    if (host === root) return true;
    if (host.endsWith("." + root)) {
      const prefix = host.slice(0, -(root.length + 1));
      if (prefix && !prefix.startsWith(".") && !prefix.endsWith(".")) return true;
    }
  }
  return false;
}

/** Trim, turn webcal:// into https://, and accept only a Luma https URL. Null when it is not. */
export function normalizeLumaUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > MAX_LUMA_URL_LENGTH || /\s/.test(value) || value.includes("\\")) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  if (/^webcal:\/\//i.test(value)) value = "https://" + value.slice("webcal://".length);
  if (value.length > MAX_LUMA_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!lumaHost(url.hostname)) return null;
  return value;
}

/** Hostname plus the last 4 characters of the full URL. Not the link. */
export function lumaHint(raw: string): string {
  const normalized = normalizeLumaUrl(raw);
  if (!normalized) return "";
  const host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, "");
  return host + "/…" + normalized.slice(-4);
}

function collectSecrets(secrets: string[]): string[] {
  const found: string[] = [];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    found.push(secret);
    try {
      const url = new URL(secret);
      found.push(url.href, url.hostname, url.pathname);
      if (url.search.length > 1) found.push(url.search, url.search.slice(1));
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/** Remove any copy of the ICS URL (and its host) from a message. */
export function redactText(raw: string, secrets: string[]): string {
  let out = raw;
  for (const secret of collectSecrets(secrets)) out = out.split(secret).join("[url]");
  out = out.replace(/https?:\/\/[^\s)\]}"']+/gi, "[url]").replace(/webcal:\/\/[^\s)\]}"']+/gi, "[url]");
  return out.replace(/\s+/g, " ").trim();
}

export function publicSyncError(error: unknown, secrets: string[]): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const redacted = redactText(parts.join(" "), secrets);
  if (!redacted || redacted === "luma_ics_rejected" || redacted.includes("[url]") || redacted.includes("luma_ics_rejected")) return LUMA_SYNC_ERROR;
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && redacted.includes(secret)) return LUMA_SYNC_ERROR;
  }
  return redacted.slice(0, 240);
}
