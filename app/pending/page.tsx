"use client";

import { authClient } from "@/lib/auth-client";
import { browserPushDeps, signOutClearingPush } from "@/lib/push-logout";

type ApprovalUser = { approvalStatus?: "pending" | "approved" | "rejected" };

export default function PendingPage() {
  const { data: session, isPending } = authClient.useSession();
  const status = (session?.user as ApprovalUser | undefined)?.approvalStatus;

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <img className="auth-brand-icon" src="/icons/icon-192.v5.png" alt="" width="88" height="88" />
        <p className="eyebrow">SERPIX</p>
        <h1>{status === "rejected" ? "Solicitud rechazada" : "Acceso pendiente"}</h1>
        <p className="auth-copy">
          {isPending ? "Verificando tu sesión…" : status === "rejected"
            ? "El administrador no aprobó el acceso a este espacio."
            : "Tu cuenta de Google fue registrada. Pedí una invitación al administrador para poder ingresar."}
        </p>
        <button className="secondary-button" onClick={() => void signOutClearingPush(() => authClient.signOut(), browserPushDeps())}>Cerrar sesión</button>
      </section>
    </main>
  );
}
