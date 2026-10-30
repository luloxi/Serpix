"use client";

import { useEffect, useState } from "react";

type UserRecord = {
  id: string;
  name: string;
  email: string;
  approvalStatus: "pending" | "approved" | "rejected";
  createdAt: number;
};

export default function AdminUsers() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    if (!response.ok) {
      setError("No se pudo cargar la lista de usuarios.");
      setLoading(false);
      return;
    }
    const data = (await response.json()) as { users: UserRecord[] };
    setUsers(data.users);
    setError("");
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  async function setStatus(userId: string, approvalStatus: "approved" | "rejected") {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalStatus }),
    });
    if (!response.ok) {
      setError("No se pudo actualizar el acceso.");
      return;
    }
    await refresh();
  }

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Usuarios registrados</h2>
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
                <span className={`status status-${user.approvalStatus}`}>{user.approvalStatus}</span>
              </div>
              <div className="user-actions">
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
