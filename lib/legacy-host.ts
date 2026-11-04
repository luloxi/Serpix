const LEGACY_HOSTS = new Set(["erp.lulox.com.ar", "serpix.lulox.com.ar"]);
const CANONICAL_ORIGIN = "https://garpen.lulox.com.ar";

/** 301 from a retired public host to Garpen (GET/HEAD pages only). Path and query are preserved.
 * /api/* and non-GET requests pass through: Cuentix posts to erp.lulox.com.ar/api/integrations/... and a 301 would turn its POST into a GET. */
export function legacyHostRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!LEGACY_HOSTS.has(url.hostname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname.startsWith("/api/")) return null;
  return Response.redirect(CANONICAL_ORIGIN + url.pathname + url.search, 301);
}
