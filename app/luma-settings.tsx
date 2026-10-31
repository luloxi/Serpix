"use client";

import { useEffect, useState } from "react";

type LumaView = {
  configured: boolean;
  hint: string | null;
  savedAt: number | null;
  envFallback: boolean;
  lastAttemptAt: number | null;
  lastSyncAt: number | null;
  lastStatus: string | null;
  lastCount: number | null;
  lastError: string | null;
};

const artFormat = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function formatArt(ms: number): string {
  return artFormat.format(new Date(ms)) + " ART";
}

function statusLine(view: LumaView): string {
  if (view.lastStatus === "error") return view.lastError || "La última sincronización falló.";
  if (view.lastSyncAt) {
    const count = view.lastCount ?? 0;
    return "Última sincronización: " + formatArt(view.lastSyncAt) + " · " + count + (count === 1 ? " evento" : " eventos");
  }
  return "Todavía no se sincronizó.";
}

function isView(value: unknown): value is LumaView {
  return !!value && typeof value === "object" && typeof (value as { configured?: unknown }).configured === "boolean";
}

export default function LumaSettings() {
  const [view, setView] = useState<LumaView | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/settings/luma", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isView(body)) {
      setError("No se pudo cargar la configuración de Luma.");
      return;
    }
    setView(body);
    setError("");
  }

  useEffect(() => { void load(); }, []);

  async function syncNow() {
    setBusy("sync");
    setError("");
    try {
      const response = await fetch("/api/settings/luma/sync", { method: "POST" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok || !isView(body)) {
        setError((body && "error" in body && body.error) || "No se pudo sincronizar.");
        return;
      }
      setView(body);
    } catch {
      setError("No se pudo sincronizar.");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    const url = draft.trim();
    if (!url || busy) return;
    setBusy("save");
    setError("");
    let saved = false;
    try {
      const response = await fetch("/api/settings/luma", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok || !isView(body)) {
        setError((body && "error" in body && body.error) || "No se pudo guardar el link.");
        return;
      }
      setDraft("");
      setEditing(false);
      setView(body);
      saved = true;
    } catch {
      setError("No se pudo guardar el link.");
    } finally {
      setBusy("");
    }
    if (saved) await syncNow();
  }

  async function clearLink() {
    setBusy("clear");
    setError("");
    try {
      const response = await fetch("/api/settings/luma", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok || !isView(body)) {
        setError((body && "error" in body && body.error) || "No se pudo quitar el link.");
        return;
      }
      setView(body);
      setDraft("");
      setEditing(false);
      setConfirmClear(false);
    } catch {
      setError("No se pudo quitar el link.");
    } finally {
      setBusy("");
    }
  }

  const configured = view?.configured === true;
  const showInput = !view || !configured || editing;
  const syncDisabled = busy !== "" || !view || (!configured && !view.envFallback);

  return (
    <section className="luma-settings" aria-labelledby="luma-settings-title" aria-busy={busy !== ""}>
      <h2 id="luma-settings-title">Eventos de Luma</h2>
      {showInput ? (
        <div className="luma-field">
          <label htmlFor="luma-ics-url">Pegá el link ICS de tu calendario de Luma</label>
          <input
            id="luma-ics-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Pegá el link ICS de tu calendario de Luma"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
          />
          <div className="luma-actions">
            <button type="button" className="primary" onClick={() => void save()} disabled={busy !== "" || draft.trim() === ""}>Guardar</button>
            {editing && <button type="button" onClick={() => { setEditing(false); setDraft(""); }} disabled={busy !== ""}>Cancelar</button>}
          </div>
        </div>
      ) : (
        <div className="luma-field">
          <p className="luma-hint">{view?.hint}</p>
          <div className="luma-actions">
            <button type="button" onClick={() => { setEditing(true); setDraft(""); setConfirmClear(false); }} disabled={busy !== ""}>Cambiar</button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy !== ""}>Quitar</button>
          </div>
        </div>
      )}
      {confirmClear && configured && (
        <div className="luma-confirm">
          <p>Quitar borra solo el link guardado. Los eventos ya importados se quedan.</p>
          <div className="luma-actions">
            <button type="button" className="primary" onClick={() => void clearLink()} disabled={busy !== ""}>Confirmar</button>
            <button type="button" onClick={() => setConfirmClear(false)} disabled={busy !== ""}>Cancelar</button>
          </div>
        </div>
      )}
      {!configured && view?.envFallback && <p>Usando el link configurado en el servidor</p>}
      <div className="luma-actions">
        <button type="button" onClick={() => void syncNow()} disabled={syncDisabled}>Sincronizar ahora</button>
      </div>
      {view && <p className="luma-status">{statusLine(view)}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <ol>
        <li>En Luma abrí Settings (Configuración).</li>
        <li>Bajá hasta Calendar Syncing (Third Party Accounts) y tocá Add iCal Subscription.</li>
        <li>Elegí tu app de calendario y copiá el link .ics que te muestra (empieza con https://api.lu.ma/ics/…). Ese link trae los eventos que organizás o a los que te anotaste. También sirve el de un calendario público: en su página, Add iCal Subscription.</li>
      </ol>
      <p className="luma-note">El link es privado, se guarda cifrado y no se vuelve a mostrar.</p>
    </section>
  );
}
