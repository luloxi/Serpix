// In-memory client engine for encrypted accounts. The plaintext database never leaves the tab.
import { runOutsideEngineSession, bindEngineSession, boundEngineSession, type EngineSession } from "./ambient.ts";
import { openLocalDb, type LocalD1 } from "./d1-local.ts";
import { createLocalApi, installLocalFetch } from "./local-api.ts";
import { createSync, installSyncSchema, type SyncStatus } from "./sync.ts";
import { setDocumentNumberProvider, type DocType } from "../documents.ts";
import { setRecurringIdFactory } from "../recurring.ts";

export const E2E_ENGINE_MARKER = "serpix-e2e-engine";

const markerRoot = globalThis as { __serpixE2E?: string[] };
markerRoot.__serpixE2E ??= [];
markerRoot.__serpixE2E.push(E2E_ENGINE_MARKER);

export type EngineStatus = SyncStatus;

export type Engine = {
  userId: string;
  d1: LocalD1;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  status: () => EngineStatus;
  idle: () => Promise<void>;
  handle: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
};

/** True only for a non-admin whose account is in e2e mode. Server-mode users keep the network API. */
export function shouldUseLocalEngine(input: { role?: string | null; encryptionMode?: string | null }): boolean {
  return input.role !== "admin" && input.encryptionMode === "e2e";
}

export type StartEngineOptions = {
  userId: string;
  dek: CryptoKey;
  fetch: typeof fetch;
  wasm: Uint8Array | ArrayBuffer;
  name?: string;
  email?: string;
  role?: string;
  baseUrl?: string;
  installFetch?: boolean;
  onStatus?: (status: EngineStatus) => void;
  events?: EventTarget;
};

let networkFetch: typeof fetch | null = null;
let networkBase = "http://e2e.local";
let holders = 0;
const live = new Set<Engine>();

async function allocateNumber(kind: DocType): Promise<number> {
  const fetchImpl = networkFetch;
  if (!fetchImpl) throw new Error("counter");
  return runOutsideEngineSession(async () => {
    const response = await fetchImpl(networkBase + "/api/e2e/counter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!response.ok) throw new Error("counter");
    const body = await response.json() as { value?: unknown };
    const value = Number(body.value);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("counter");
    return value;
  });
}

function holdFactories(fetchImpl: typeof fetch, baseUrl: string) {
  networkFetch = fetchImpl;
  networkBase = baseUrl;
  if (holders === 0) {
    setDocumentNumberProvider(allocateNumber);
    setRecurringIdFactory((ruleId, period) => `rr.${ruleId}.${period}`);
  }
  holders += 1;
}

function releaseFactories() {
  holders = Math.max(0, holders - 1);
  if (holders === 0) {
    setDocumentNumberProvider(null);
    setRecurringIdFactory(null);
    networkFetch = null;
  }
}

export async function startEngine(options: StartEngineOptions): Promise<Engine> {
  const baseUrl = options.baseUrl ?? "http://e2e.local";
  const opened = await openLocalDb({ wasm: options.wasm });
  await installSyncSchema(opened.d1);
  holdFactories(options.fetch, baseUrl);
  const session: EngineSession = {
    userId: options.userId,
    db: opened.d1,
    env: {},
    role: options.role ?? "user",
    name: options.name ?? "",
    email: options.email ?? "",
    approvalStatus: "approved",
  };
  bindEngineSession(session);
  const sync = createSync({
    userId: options.userId,
    dek: options.dek,
    db: opened.d1,
    fetch: options.fetch,
    baseUrl,
    onStatus: options.onStatus,
    events: options.events,
  });
  const api = createLocalApi({ session, fetch: options.fetch, baseUrl });
  let uninstall = () => {};
  let closed = false;
  const engine: Engine = {
    userId: options.userId,
    d1: opened.d1,
    pull: () => sync.pull(),
    push: () => sync.push(),
    status: () => sync.status(),
    idle: () => sync.idle(),
    handle(input, init) {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      return sync.exclusive(() => api.handle(request));
    },
    async close() {
      if (closed) return;
      closed = true;
      live.delete(engine);
      sync.close();
      releaseFactories();
      if (boundEngineSession() === session) bindEngineSession(null);
      uninstall();
      opened.db.close();
    },
  };
  if (options.installFetch) {
    uninstall = installLocalFetch({
      fetch: options.fetch,
      pull: () => sync.pull(),
      push: () => sync.push(),
      handle: (request) => sync.exclusive(() => api.handle(request)),
    });
  }
  live.add(engine);
  try {
    await sync.pull();
  } catch (error) {
    await engine.close();
    throw error;
  }
  return engine;
}

/** Drops every in-memory database this tab started. */
export async function closeEngine(): Promise<void> {
  const all = [...live];
  live.clear();
  for (const engine of all) await engine.close();
}
