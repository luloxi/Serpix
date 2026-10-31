"use client";

import { authClient } from "@/lib/auth-client";
import { browserPushDeps, signOutClearingPush } from "@/lib/push-logout";

export default function SignOutButton() {
  return (
    <button className="secondary-button" onClick={() => void signOutClearingPush(() => authClient.signOut(), browserPushDeps())}>
      Cerrar sesión
    </button>
  );
}
