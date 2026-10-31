// Explicit sign-out order. pagehide does not call this: a reload may unlock from the device cache.

export const DEVICE_WIPE_WARNING =
  "No pudimos borrar la clave de este dispositivo: cerrá las otras pestañas de Serpix y reintentá";

export type SignOutSteps = {
  removePush: () => Promise<void>;
  e2eActive: boolean;
  wipeVault: () => Promise<void>;
  uninstallFetch: () => void;
  closeEngine: () => Promise<void>;
  authSignOut: () => Promise<unknown>;
};

export type SignOutResult = {
  /** The session cookie was still cleared. The UI must not treat this as a clean sign-out. */
  deviceWipeFailed: boolean;
};

/** Visible warning when the device key could not be deleted. Null when the wipe succeeded. */
export function signOutWarning(result: SignOutResult): string | null {
  return result.deviceWipeFailed ? DEVICE_WIPE_WARNING : null;
}

/**
 * Push first (it needs the session cookie), then for an e2e session the vault
 * (memory DEK and device cache), the local fetch hook, and the engine, and only
 * then the auth cookie. A failed wipe still ends the session so the cookie does
 * not outlive the key, and the result tells the UI to show a warning.
 */
export async function runSignOut(steps: SignOutSteps): Promise<SignOutResult> {
  try { await steps.removePush(); } catch { /* push cleanup never blocks logout */ }
  let deviceWipeFailed = false;
  if (steps.e2eActive) {
    try { await steps.wipeVault(); } catch { deviceWipeFailed = true; }
    try { steps.uninstallFetch(); } catch { /* still close the engine */ }
    try { await steps.closeEngine(); } catch { /* still sign out */ }
  }
  await steps.authSignOut();
  return { deviceWipeFailed };
}
