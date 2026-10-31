// Serves the legacy API URLs against the in-memory database. Route modules load with
// dynamic import() so the server bundle does not pull them in through this file's graph
// until an e2e session actually calls them — and the engine file itself is dynamic.
import { AI_DISABLED_MESSAGE, SCAN_LIMIT_MESSAGE } from "../ai-quota.ts";
import { SCAN_AI_WARNING } from "../e2e-server.ts";
import { MAX_RECEIPT_BASE64_CHARS, MAX_RECEIPT_BYTES, RECEIPT_MODEL, RECEIPT_TOO_BIG_MESSAGE } from "../receipt.ts";
import { isReceiptMime, sniffMime } from "../receipts-db.ts";
import { runOutsideEngineSession, runWithEngineSession, type EngineSession } from "./ambient.ts";
import { bytesToBase64 } from "./sync.ts";

type Handler = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, Handler>;

const PULL_GAP_MS = 1500;

const loaders = {
  data: () => import("@/app/api/data/[resource]/route"),
  dataId: () => import("@/app/api/data/[resource]/[id]/route"),
  totals: () => import("@/app/api/finance/totals/route"),
  documents: () => import("@/app/api/documents/route"),
  documentId: () => import("@/app/api/documents/[id]/route"),
  documentHours: () => import("@/app/api/documents/time-entries/route"),
  time: () => import("@/app/api/time-entries/route"),
  timeId: () => import("@/app/api/time-entries/[id]/route"),
  timer: () => import("@/app/api/timer/route"),
  recurring: () => import("@/app/api/recurring/route"),
  recurringId: () => import("@/app/api/recurring/[id]/route"),
  receiptId: () => import("@/app/api/receipts/[id]/route"),
  avatar: () => import("@/app/api/avatar/[id]/route"),
} as const;

type RouteName = keyof typeof loaders;

const cache = new Map<RouteName, Promise<RouteModule>>();

function moduleOf(name: RouteName): Promise<RouteModule> {
  let pending = cache.get(name);
  if (!pending) {
    pending = loaders[name]() as unknown as Promise<RouteModule>;
    cache.set(name, pending);
  }
  return pending;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function callRoute(name: RouteName, method: string, request: Request, params: Record<string, string>): Promise<Response> {
  const mod = await moduleOf(name);
  const handler = mod[method];
  if (typeof handler !== "function") return Response.json({ error: "Not found" }, { status: 405 });
  return handler(request, { params: Promise.resolve(params) });
}

type Rule = { name: RouteName; params: Record<string, string> } | { name: "scan" } | null;

export function matchLocalPath(pathname: string): Rule {
  const path = pathname.replace(/\/+$/, "") || "/";
  let match: RegExpMatchArray | null;
  if (path === "/api/receipts/scan") return { name: "scan" };
  if ((match = path.match(/^\/api\/receipts\/([^/]+)$/))) return { name: "receiptId", params: { id: decode(match[1]) } };
  if (path === "/api/documents/time-entries") return { name: "documentHours", params: {} };
  if ((match = path.match(/^\/api\/documents\/([^/]+)$/))) return { name: "documentId", params: { id: decode(match[1]) } };
  if (path === "/api/documents") return { name: "documents", params: {} };
  if (path === "/api/finance/totals") return { name: "totals", params: {} };
  if ((match = path.match(/^\/api\/time-entries\/([^/]+)$/))) return { name: "timeId", params: { id: decode(match[1]) } };
  if (path === "/api/time-entries") return { name: "time", params: {} };
  if (path === "/api/timer") return { name: "timer", params: {} };
  if ((match = path.match(/^\/api\/recurring\/([^/]+)$/))) return { name: "recurringId", params: { id: decode(match[1]) } };
  if (path === "/api/recurring") return { name: "recurring", params: {} };
  if ((match = path.match(/^\/api\/avatar\/([^/]+)$/))) return { name: "avatar", params: { id: decode(match[1]) } };
  if ((match = path.match(/^\/api\/data\/([^/]+)\/([^/]+)$/))) return { name: "dataId", params: { resource: decode(match[1]), id: decode(match[2]) } };
  if ((match = path.match(/^\/api\/data\/([^/]+)$/))) return { name: "data", params: { resource: decode(match[1]) } };
  return null;
}

export function isInquiriesPath(pathname: string): boolean {
  return pathname === "/api/inquiries" || pathname.startsWith("/api/inquiries/");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function scanReceipt(request: Request, session: EngineSession, network: typeof fetch, baseUrl: string): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "Archivo inválido" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Falta el archivo" }, 400);
  if (file.size > MAX_RECEIPT_BYTES) return json({ error: RECEIPT_TOO_BIG_MESSAGE }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !isReceiptMime(mime)) return json({ error: "Formato no admitido. Usá JPG, PNG, WebP o PDF." }, 415);
  const data = bytesToBase64(bytes);
  if (data.length > MAX_RECEIPT_BASE64_CHARS) return json({ error: RECEIPT_TOO_BIG_MESSAGE }, 413);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await session.db.prepare(
      "INSERT INTO receipts (id,user_id,transaction_id,mime,size,data,extracted,read_ok,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(id, session.userId, null, mime, bytes.length, data, null, 0, now).run();
  } catch (error) {
    console.error("receipt_insert_failed", String(error));
    return json({ error: "No se pudo guardar el ticket" }, 500);
  }
  const ai = form.get("ai");
  if (ai !== "1") return json({ receiptId: id, mime, ok: false, fields: null, model: RECEIPT_MODEL }, 201);

  const outbound = new FormData();
  outbound.set("file", new File([bytes], file.name || "ticket", { type: mime }));
  let response: Response;
  try {
    response = await runOutsideEngineSession(() => network(baseUrl + "/api/e2e/scan-ai", { method: "POST", body: outbound }));
  } catch {
    return json({ receiptId: id, mime, ok: false, fields: null, model: RECEIPT_MODEL, error: "Sin conexión" }, 503);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { body = {}; }
  if (body.ok === true && body.fields && typeof body.fields === "object") {
    await session.db.prepare("UPDATE receipts SET extracted = ?, read_ok = 1 WHERE id = ? AND user_id = ?").bind(JSON.stringify(body.fields), id, session.userId).run();
  }
  const merged: Record<string, unknown> = {
    receiptId: id,
    mime,
    model: RECEIPT_MODEL,
    ok: false,
    fields: null,
    ...body,
    warning: typeof body.warning === "string" ? body.warning : SCAN_AI_WARNING,
  };
  if (response.status === 429 && merged.error == null) merged.error = SCAN_LIMIT_MESSAGE;
  if (response.status === 200 && merged.aiStatus === "disabled" && merged.message == null) merged.message = AI_DISABLED_MESSAGE;
  const status = response.status >= 400 ? response.status : 201;
  return json(merged, status);
}

export type LocalApi = {
  handle(request: Request): Promise<Response>;
};

export function createLocalApi(options: { session: EngineSession; fetch: typeof fetch; baseUrl: string }): LocalApi {
  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url, options.baseUrl);
      const matched = matchLocalPath(url.pathname);
      if (!matched) return json({ error: "Not found" }, 404);
      return runWithEngineSession(options.session, async () => {
        if (matched.name === "scan") return scanReceipt(request, options.session, options.fetch, options.baseUrl);
        return callRoute(matched.name, request.method, request, matched.params);
      });
    },
  };
}

function requestUrl(input: RequestInfo | URL, init?: RequestInit): URL {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  const base = typeof location !== "undefined" && location.href ? location.href : "http://local.serpix/";
  return new URL(raw, init && typeof input === "string" ? base : base);
}

export function installLocalFetch(options: {
  fetch: typeof fetch;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  handle: (request: Request) => Promise<Response>;
}): () => void {
  const network = options.fetch;
  const previous = globalThis.fetch;
  let lastPull = 0;
  const wrapped: typeof fetch = async (input, init) => {
    const url = requestUrl(input, init);
    if (isInquiriesPath(url.pathname)) return Response.json({ items: [] });
    if (!matchLocalPath(url.pathname)) return network(input, init);
    const request = input instanceof Request && !init ? input : new Request(input, init);
    if (request.method === "GET" || request.method === "HEAD") {
      const now = Date.now();
      if (now - lastPull >= PULL_GAP_MS) {
        lastPull = now;
        try { await options.pull(); } catch { /* the screen still reads the local copy */ }
      }
    }
    const response = await options.handle(request);
    if (request.method !== "GET" && request.method !== "HEAD") void options.push();
    return response;
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = previous;
  };
}
