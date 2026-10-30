"use client";

import { authClient } from "@/lib/auth-client";

export default function SignOutButton() {
  return (
    <button className="secondary-button" onClick={() => void authClient.signOut()}>
      Cerrar sesión
    </button>
  );
}
