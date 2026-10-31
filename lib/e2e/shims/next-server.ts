// Browser stand-in for next/server. Server builds keep the real module (alias is browser-only).
export const E2E_NEXT_SERVER_SHIM = "serpix-e2e-next-server-shim";

const markerRoot = globalThis as { __serpixE2E?: string[] };
markerRoot.__serpixE2E ??= [];
markerRoot.__serpixE2E.push(E2E_NEXT_SERVER_SHIM);

export class NextResponse extends Response {
  static json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new NextResponse(JSON.stringify(data), { status: init?.status, statusText: init?.statusText, headers });
  }
}
