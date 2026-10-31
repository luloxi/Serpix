"use client";

import { useState } from "react";

const COPY: Record<string, string> = {
  used: "Esta invitación ya se usó.",
  expired: "Esta invitación está vencida.",
  revoked: "Esta invitación fue revocada.",
  invalid: "Esta invitación no es válida.",
  full: "No hay lugar: se alcanzó el tope de usuarios.",
  rejected: "El administrador rechazó tu acceso. Una invitación no lo revierte.",
};

export default function InviteAccept({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function accept() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invites/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (response.status === 401) {
        setMessage("La sesión venció. Volvé a iniciar sesión.");
        setBusy(false);
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { status?: string };
      if (data.status === "ok" || data.status === "already_approved") {
        window.location.assign("/dashboard");
        return;
      }
      setMessage(COPY[data.status ?? ""] || "No se pudo aceptar la invitación.");
      setBusy(false);
    } catch {
      setMessage("No se pudo aceptar la invitación.");
      setBusy(false);
    }
  }

  return (
    <>
      <p className="auth-copy">Si el enlace sigue vigente, aceptalo para entrar a Serpix.</p>
      <button type="button" className="primary-button invite-accept" onClick={() => void accept()} disabled={busy}>
        {busy ? "Aceptando…" : "Aceptar invitación"}
      </button>
      {message && <p className="error-message" role="status">{message}</p>}
    </>
  );
}
