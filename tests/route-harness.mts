// Import this module BEFORE any route. Its body registers the resolve hook; route modules
// must then be loaded with dynamic import() so the hook is already installed.
import { register } from "node:module";

register(new URL("./route-loader.mjs", import.meta.url));

export type TestSession = {
  user: { id: string; role: string; approvalStatus: string; email: string; name: string };
};

declare global {
  var __testSession: TestSession | null | undefined;
  var __testEnv: Record<string, unknown> | undefined;
  var __testHeaders: Record<string, string> | undefined;
  var __testSessionReads: number | undefined;
}

export function asUser(id: string | null, role = "user", approvalStatus = "approved") {
  if (id == null) {
    globalThis.__testSession = null;
    return;
  }
  globalThis.__testSession = {
    user: { id, role, approvalStatus, email: id + "@test.local", name: id },
  };
}

export function setEnv(d1: unknown, extra: Record<string, unknown> = {}) {
  globalThis.__testEnv = {
    DB: d1,
    VAPID_PUBLIC_KEY: "test-vapid-public",
    VAPID_PRIVATE_KEY: "test-vapid-private",
    PORTFOLIO_INBOUND_SECRET: "test-inbound-secret",
    AI: {
      async run() { return { response: "" }; },
      async toMarkdown() { return [{ data: "" }]; },
    },
    ...extra,
  };
}

export function sessionReads() {
  return globalThis.__testSessionReads ?? 0;
}

export function resetSessionReads() {
  globalThis.__testSessionReads = 0;
}

type Handler = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(
  routeModule: Record<string, Handler>,
  method: string,
  url: string,
  opts: { json?: unknown; form?: FormData; params?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const handler = routeModule[method];
  if (!handler) throw new Error("Missing " + method + " on route");
  const headers = new Headers(opts.headers);
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  }
  const response = await handler(new Request(url, { method, headers, body }), { params: Promise.resolve(opts.params ?? {}) });
  const text = await response.text();
  let parsed: unknown = text;
  if (!text) parsed = null;
  else {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: response.status, body: parsed, text };
}

let tail: Promise<void> = Promise.resolve();

/** Serializes route calls across test files. They share one process-wide session and env. */
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
