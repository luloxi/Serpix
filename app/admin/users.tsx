"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readSwr, swrPaths, writeSwr } from "@/lib/swr-cache";

type UserRecord = {
  id: string;
  name: string;
  email: string;
  approvalStatus: "pending" | "approved" | "rejected";
  role?: string;
  createdAt: number;
  aiReceipts?: boolean;
};

export default function AdminUsers({ userId }: { userId: string }) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState("");
  const [aiBusy, setAiBusy] = useState("");
  const saw = useRef(false);

  useLayoutEffect(() => {
    const cached = readSwr<UserRecord[]>(userId, swrPaths.adminUsers);
    if (!Array.isArray(cached)) return;
    setUsers(cached);
    saw.current = true;
    setLoading(false);
    setRevalidating(true);
  }, [userId]);

  async function refresh() {
    if (saw.current) setRevalidating(true);
    else setLoading(true);
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      if (!response.ok) {
        setError("No se pudo cargar la lista de usuarios.");
        return;
      }
      const data = (await response.json()) as { users: UserRecord[] };
      const users = data.users.map((user) => ({ id: user.id, name: user.name, email: user.email, approvalStatus: user.approvalStatus, role: user.role, createdAt: user.createdAt, aiReceipts: user.aiReceipts }));
      setUsers(users);
      writeSwr(userId, swrPaths.adminUsers, users);
      saw.current = true;
      setError("");
    } finally {
      setLoading(false);
      setRevalidating(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function setStatus(userId: string, approvalStatus: "approved" | "rejected") {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalStatus }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error || "No se pudo actualizar el acceso.");
      return;
    }
    await refresh();
  }

  async function setAi(userId: string, aiReceipts: boolean) {
    setAiBusy(userId);
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiReceipts }),
    });
    setAiBusy("");
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error || "No se pudo cambiar la lectura de tickets.");
      return;
    }
    await refresh();
  }

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Usuarios registrados{revalidating ? <span className="swr-status">actualizando…</span> : null}</h2>
        <button className="secondary-button" onClick={() => void refresh()}>Actualizar</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {loading ? <p>Cargando usuarios…</p> : users.length === 0 ? (
        <p>No hay usuarios registrados todavía.</p>
      ) : (
        <div className="user-list">
          {users.map((user) => (
            <article className="user-row" key={user.id}>
              <div>
                <strong>{user.name || "Sin nombre"}</strong>
                <p>{user.email}</p>
                <span className={`status status-${user.approvalStatus}`}>{({ pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado" } as const)[user.approvalStatus]}</span>
              </div>
              <div className="user-actions">
                {user.role !== "admin" && <button type="button" className={"ai-switch" + (user.aiReceipts ? " on" : "")} role="switch" aria-checked={user.aiReceipts === true} aria-label={user.aiReceipts ? "IA en tickets activada" : "IA en tickets apagada"} title="Activá esto si la persona te pide leer tickets con IA" disabled={aiBusy === user.id} onClick={() => void setAi(user.id, !user.aiReceipts)}><span>IA en tickets</span><span className="ai-switch-knob" aria-hidden="true" /></button>}
                {user.approvalStatus !== "approved" && <button className="primary-button compact" onClick={() => void setStatus(user.id, "approved")}>Aprobar</button>}
                {user.approvalStatus !== "rejected" && <button className="secondary-button compact" onClick={() => void setStatus(user.id, "rejected")}>Rechazar</button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
