"use client";

import { authClient } from "@/lib/auth-client";

type ApprovalUser = { approvalStatus?: "pending" | "approved" | "rejected" };

export default function PendingPage() {
  const { data: session, isPending } = authClient.useSession();
  const status = (session?.user as ApprovalUser | undefined)?.approvalStatus;

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="brand-mark">S</div>
        <p className="eyebrow">SERPIX</p>
        <h1>{status === "rejected" ? "Solicitud rechazada" : "Acceso pendiente"}</h1>
        <p className="auth-copy">
          {isPending ? "Verificando tu sesión…" : status === "rejected"
            ? "El administrador no aprobó el acceso a este espacio."
            : "Tu cuenta de Google fue registrada. El administrador debe aprobarla antes de que puedas ingresar."}
        </p>
        <button className="secondary-button" onClick={() => void authClient.signOut()}>Cerrar sesión</button>
      </section>
    </main>
  );
}
