// Node / Workers only. The browser bundle never loads this file (the session alias stops at the shim).
import { AsyncLocalStorage } from "node:async_hooks";
import { registerEngineSessionRuntime, type EngineSession } from "./ambient.ts";

const storage = new AsyncLocalStorage<EngineSession | null>();
let installed = false;

export function installNodeEngineSession(): void {
  if (installed) return;
  installed = true;
  registerEngineSessionRuntime({
    current() {
      return storage.getStore();
    },
    run(session, fn) {
      return storage.run(session, fn);
    },
  });
}

/**
 * Undefined store and an explicit null both mean "no local engine session".
 * Callers then use the real cookie session and the server D1.
 */
export function engineSessionOverride(): EngineSession | null {
  installNodeEngineSession();
  const store = storage.getStore();
  return store ?? null;
}
