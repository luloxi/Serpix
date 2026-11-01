"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readSwr, swrPaths, writeSwr } from "@/lib/swr-cache";

type InviteItem = {
  id: string;
  status: "pending" | "used" | "expired" | "revoked";
  expiresAt: number;
};

const STATUS_LABEL: Record<InviteItem["status"], string> = {
  pending: "pendiente",
  used: "usada",
  expired: "vencida",
  revoked: "revocada",
};

function formatExpiry(ms: number): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export default function InvitesAdmin({ isAdmin, userId }: { isAdmin: boolean; userId: string }) {
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [fresh, setFresh] = useState<{ url: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const saw = useRef(false);

  useLayoutEffect(() => {
    if (!isAdmin) return;
    const cached = readSwr<{ invites: InviteItem[]; enabled: boolean | null }>(userId, swrPaths.invites);
    if (!cached || !Array.isArray(cached.invites)) return;
    setInvites(cached.invites);
    setEnabled(typeof cached.enabled === "boolean" ? cached.enabled : null);
    saw.current = true;
    setRevalidating(true);
  }, [isAdmin, userId]);

  async function refresh() {
    if (saw.current) setRevalidating(true);
    try {
      const response = await fetch("/api/admin/invites", { cache: "no-store" });
      if (!response.ok) {
        setError("No se pudieron cargar las invitaciones.");
        return;
      }
      const data = (await response.json()) as { invites: InviteItem[]; enabled?: boolean };
      const nextEnabled = typeof data.enabled === "boolean" ? data.enabled : null;
      const invites = data.invites.map((invite) => ({ id: invite.id, status: invite.status, expiresAt: invite.expiresAt }));
      setInvites(invites);
      setEnabled(nextEnabled);
      writeSwr(userId, swrPaths.invites, { invites, enabled: nextEnabled });
      saw.current = true;
      setError("");
    } finally {
      setRevalidating(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) return;
    void refresh();
  }, [isAdmin]);

  if (!isAdmin) return null;

  async function generate() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await response.json().catch(() => ({}))) as { url?: string; expiresAt?: number; error?: string };
      if (!response.ok || !data.url || typeof data.expiresAt !== "number") {
        setError(data.error || "No se pudo generar la invitación.");
        return;
      }
      setFresh({ url: data.url, expiresAt: data.expiresAt });
      await refresh();
    } catch {
      setError("No se pudo generar la invitación.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("No se pudo copiar. Seleccioná el enlace.");
    }
  }

  async function revoke(id: string) {
    setError("");
    const response = await fetch("/api/admin/invites/" + encodeURIComponent(id), { method: "DELETE" });
    if (!response.ok) {
      setError("No se pudo revocar la invitación.");
      return;
    }
    await refresh();
  }

  return (
    <section className="invites-admin" aria-labelledby="serpix-invites-title">
      <p id="serpix-invites-title" className="invites-title">Invitaciones</p>
      {revalidating ? <p className="swr-status" role="status">actualizando…</p> : null}
      {enabled === false && <p className="invites-empty">Invitaciones pausadas hasta que el cifrado esté disponible.</p>}
      {enabled === true && (
        <button type="button" className="profile-menu-item" onClick={() => void generate()} disabled={busy}>
          {busy ? "Generando…" : "Generar invitación de 7 días"}
        </button>
      )}
      {fresh && (
        <div className="invites-fresh">
          <p className="invites-link">{fresh.url}</p>
          <button type="button" className="secondary-button compact" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar"}</button>
          <small>Vence el {formatExpiry(fresh.expiresAt)}. Se muestra una sola vez y no se envía.</small>
        </div>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      {invites.length === 0 ? <p className="invites-empty">No hay invitaciones.</p> : (
        <ul className="invites-list">
          {invites.map((invite) => (
            <li key={invite.id} className="invites-row">
              <span>{STATUS_LABEL[invite.status]}</span>
              {invite.status === "pending" && <button type="button" className="secondary-button compact" onClick={() => void revoke(invite.id)}>Revocar</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
