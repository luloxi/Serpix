import { NextResponse, type NextRequest } from "next/server";
import { applyProxyHeaders, buildCsp, newNonce } from "./lib/csp";

/**
 * Per-request nonce CSP. Next reads Content-Security-Policy on the *request*
 * during render and copies the nonce onto its own scripts. x-nonce is for the
 * theme script in app/layout.tsx. Static files are excluded so this proxy
 * never rewrites /_next/static, icons, the service worker, or the manifest.
 * Document responses get Cache-Control: no-store via applyProxyHeaders.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const isDev = process.env.NODE_ENV === "development";
  const csp = buildCsp({ nonce, isDev });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyProxyHeaders(response.headers, { csp, pathname: request.nextUrl.pathname });
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|icons/|favicon\\.ico|sw\\.js|theme-init\\.js|manifest|\\.well-known/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
