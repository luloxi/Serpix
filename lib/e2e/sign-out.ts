// Explicit sign-out order. pagehide does not call this: a reload may unlock from the device cache.

export type SignOutSteps = {
  removePush: () => Promise<void>;
  e2eActive: boolean;
  wipeVault: () => Promise<void>;
  uninstallFetch: () => void;
  closeEngine: () => Promise<void>;
  authSignOut: () => Promise<unknown>;
};

/**
 * Push first (it needs the session cookie), then for an e2e session the vault
 * (memory DEK and device cache), the local fetch hook, and the engine, and only
 * then the auth cookie. A failed wipe still continues so the cookie does not outlive the key.
 */
export async function runSignOut(steps: SignOutSteps): Promise<void> {
  try { await steps.removePush(); } catch { /* push cleanup never blocks logout */ }
  if (steps.e2eActive) {
    try { await steps.wipeVault(); } catch { /* still drop the fetch hook */ }
    try { steps.uninstallFetch(); } catch { /* still close the engine */ }
    try { await steps.closeEngine(); } catch { /* still sign out */ }
  }
  await steps.authSignOut();
}
