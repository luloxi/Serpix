"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { clearE2eSession, getE2eTeardown, isE2eActive, peekUninstall } from "@/lib/e2e/client-session";
import { runSignOut, signOutWarning } from "@/lib/e2e/sign-out";
import { browserPushDeps, removeDevicePush } from "@/lib/push-logout";

export default function SignOutButton({ onWarning }: { onWarning?: (message: string) => void }) {
  const [pending, setPending] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  return (
    <>
      <button
        className="secondary-button"
        disabled={pending}
        onClick={() => {
          if (pending) return;
          setPending(true);
          void logout(setWarning, onWarning).finally(() => setPending(false));
        }}
      >
        Cerrar sesión
      </button>
      {warning ? <p className="error-message" role="alert">{warning}</p> : null}
    </>
  );
}

async function logout(setWarning: (warning: string | null) => void, onWarning?: (message: string) => void) {
  const e2eActive = isE2eActive();
  const uninstallFetch = peekUninstall();
  const teardown = getE2eTeardown();
  const result = await runSignOut({
    removePush: () => removeDevicePush(browserPushDeps()),
    e2eActive,
    wipeVault: () => teardown.wipeVault(),
    uninstallFetch,
    closeEngine: () => teardown.closeEngine(),
    authSignOut: () => authClient.signOut(),
  });
  clearE2eSession();
  const message = signOutWarning(result);
  setWarning(message);
  if (message) onWarning?.(message);
}
