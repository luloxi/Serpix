"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { clearE2eSession, getE2eTeardown, isE2eActive, peekUninstall } from "@/lib/e2e/client-session";
import { runSignOut } from "@/lib/e2e/sign-out";
import { browserPushDeps, removeDevicePush } from "@/lib/push-logout";

export default function SignOutButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      className="secondary-button"
      disabled={pending}
      onClick={() => {
        if (pending) return;
        setPending(true);
        void logout().finally(() => setPending(false));
      }}
    >
      Cerrar sesión
    </button>
  );
}

async function logout() {
  const e2eActive = isE2eActive();
  const uninstallFetch = peekUninstall();
  const teardown = getE2eTeardown();
  await runSignOut({
    removePush: () => removeDevicePush(browserPushDeps()),
    e2eActive,
    wipeVault: () => teardown.wipeVault(),
    uninstallFetch,
    closeEngine: () => teardown.closeEngine(),
    authSignOut: () => authClient.signOut(),
  });
  clearE2eSession();
}
