// Tiny registry so sign-out and the profile menu can see an open e2e session
// without importing the engine (that chunk stays dynamic).

export type E2eSyncName = "idle" | "syncing" | "pending" | "offline" | "error";

export type E2eSessionView = {
  userId: string;
  email: string;
  name: string;
  passwordWrapId: string;
  passwordWrap: unknown;
  createdAt: number;
  uninstall: () => void;
  wipeVault: () => Promise<void>;
  closeEngine: () => Promise<void>;
};

let session: E2eSessionView | null = null;
let status: E2eSyncName = "idle";
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeE2eSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getE2eSession(): E2eSessionView | null {
  return session;
}

export function getE2eSyncStatus(): E2eSyncName {
  return status;
}

export function isE2eActive(): boolean {
  return session !== null;
}

export function setE2eSyncStatus(next: E2eSyncName): void {
  if (status === next) return;
  status = next;
  emit();
}

export function activateE2eSession(next: E2eSessionView): void {
  session = next;
  emit();
}

export function peekUninstall(): () => void {
  return session?.uninstall ?? (() => {});
}

/** Captured by sign-out before any await. The callbacks live in the browser-only gate. */
export function getE2eTeardown(): { wipeVault: () => Promise<void>; closeEngine: () => Promise<void> } {
  return {
    wipeVault: session?.wipeVault ?? (async () => {}),
    closeEngine: session?.closeEngine ?? (async () => {}),
  };
}

export function clearE2eSession(): void {
  session = null;
  status = "idle";
  emit();
}
