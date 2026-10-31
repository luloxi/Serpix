// Session bridge with no node: imports. The browser shim reads the bound session.
// Node registers an AsyncLocalStorage runtime from lib/e2e/node-session.ts.

import type { D1Like } from "../finance.ts";

export type EngineSession = {
  userId: string;
  db: D1Like;
  env: Record<string, unknown>;
  role: string;
  name?: string;
  email?: string;
  approvalStatus?: string;
};

type Runtime = {
  current(): EngineSession | null | undefined;
  run<T>(session: EngineSession | null, fn: () => Promise<T>): Promise<T>;
};

let runtime: Runtime | null = null;
let bound: EngineSession | null = null;

export function registerEngineSessionRuntime(next: Runtime): void {
  runtime = next;
}

export function bindEngineSession(session: EngineSession | null): void {
  bound = session;
}

export function boundEngineSession(): EngineSession | null {
  if (runtime) {
    const current = runtime.current();
    if (current !== undefined) return current;
  }
  return bound;
}

export function runWithEngineSession<T>(session: EngineSession, fn: () => Promise<T>): Promise<T> {
  if (runtime) return runtime.run(session, fn);
  const previous = bound;
  bound = session;
  return Promise.resolve().then(fn).finally(() => {
    bound = previous;
  });
}

/** Server calls (counter, scan-ai, push, pull) must not see the local database. */
export function runOutsideEngineSession<T>(fn: () => Promise<T>): Promise<T> {
  if (runtime) return runtime.run(null, fn);
  const previous = bound;
  bound = null;
  return Promise.resolve().then(fn).finally(() => {
    bound = previous;
  });
}
