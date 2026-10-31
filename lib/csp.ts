/**
 * Strict Content-Security-Policy for Serpix.
 *
 * Pure string builder: the proxy (and the tests) pass the nonce and whether
 * this is a dev server. Production output never includes 'unsafe-eval' or ws:.
 *
 * style-src keeps 'unsafe-inline' and does NOT carry a nonce. In CSP, a nonce
 * or a hash in style-src makes the browser ignore 'unsafe-inline'. React style
 * attributes (and any <style> Next emits) need that keyword; a style nonce
 * would turn them off. Script nonces do not have this clash because script-src
 * does not use 'unsafe-inline'.
 *
 * 'strict-dynamic' is the nonce policy from the Next.js CSP guide. CSP3
 * browsers then ignore the host list ('self' stays as a fallback for older
 * browsers) and run only a script that bears this request's nonce, plus
 * scripts that one loads. 'wasm-unsafe-eval' is only there so Argon2id
 * (hash-wasm) and the in-browser SQLite wasm can compile. It is not 'unsafe-eval'.
 */

/** Google profile photo hosts. The workspace renders session.user.image (the OAuth picture URL) in an <img>. */
export const CSP_IMG_HOSTS = [
  "https://lh3.googleusercontent.com",
  "https://lh4.googleusercontent.com",
  "https://lh5.googleusercontent.com",
  "https://lh6.googleusercontent.com",
] as const;

/**
 * Hosts the browser actually fetch()es. lib/avatar-client.ts downloads a photo
 * once and stores a data: URL; those calls are connect-src, not img-src.
 * Gravatar and unavatar answer on these hosts (no redirect to a CDN).
 */
export const CSP_CONNECT_HOSTS = ["https://gravatar.com", "https://unavatar.io"] as const;

/** Next.js reads the first nonce- source that matches this (see getScriptNonceFromHeader). */
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // File-input camera capture is not getUserMedia, so camera=() does not block ticket photos.
  // WebAuthn (passkey wrap) needs the publickey-credentials features on this origin.
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  // Google sign-in is a full-page redirect (better-auth sets window.location), not a popup.
  // same-origin-allow-popups keeps window.open (wa.me, profile search) from losing its opener.
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
} as const;

/**
 * HTML (and the RSC or action request that shares its URL) must not be stored.
 * The CSP nonce is valid for that one response.
 *
 * Kept out of SECURITY_HEADERS. Those four are repeated for static assets in
 * public/_headers, and assets stay cacheable.
 */
export const DOCUMENT_CACHE_CONTROL = "no-store";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Headers proxy.ts writes on the response. Cache-Control is added only for a
 * non-API path that does not already have one.
 *
 * The proxy runs before the route. On OpenNext the proxy header replaces the
 * route's (middleware wins at flush). Emitting no-store for /api would replace
 * an avatar's `private, max-age=31536000, immutable` and any other route policy.
 * Static files never reach the proxy.
 */
export function applyProxyHeaders(headers: Headers, { csp, pathname }: { csp: string; pathname: string }): void {
  headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (isApiPath(pathname) || headers.has("cache-control")) return;
  headers.set("Cache-Control", DOCUMENT_CACHE_CONTROL);
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp({ nonce, isDev }: { nonce: string; isDev: boolean }): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Invalid CSP nonce");
  const dev = isDev === true;
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'"];
  if (dev) script.push("'unsafe-eval'");
  const connect = ["'self'", ...CSP_CONNECT_HOSTS];
  if (dev) connect.push("ws:");
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${CSP_IMG_HOSTS.join(" ")}`,
    `connect-src ${connect.join(" ")}`,
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}
