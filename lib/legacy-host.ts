const LEGACY_HOSTS = new Set(["erp.lulox.com.ar", "serpix.lulox.com.ar"]);
const CANONICAL_ORIGIN = "https://garpen.lulox.com.ar";

/** 301 from a retired public host to Garpen. Path and query are preserved. */
export function legacyHostRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!LEGACY_HOSTS.has(url.hostname)) return null;
  return Response.redirect(CANONICAL_ORIGIN + url.pathname + url.search, 301);
}
