"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import type { CredentialsLike } from "@/lib/crypto/passkey";
import { getE2eSession, getE2eSyncStatus, subscribeE2eSession } from "@/lib/e2e/client-session";
import { ADD_PASSKEY_NOTE, COPY, PASSKEY_NO_PRF, WRONG_PASSWORD, passkeyNote, passkeySelectable, syncStatusText, type PasskeyCapability } from "@/lib/e2e/gate";

async function detectPasskey(): Promise<PasskeyCapability> {
  const credentials = typeof navigator !== "undefined" && !!navigator.credentials?.create;
  if (!credentials || typeof PublicKeyCredential === "undefined") return { credentials: false, prf: false };
  const cred = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  if (typeof cred.getClientCapabilities !== "function") return { credentials: true, prf: null };
  try {
    const caps = await cred.getClientCapabilities();
    if (caps.prf === true) return { credentials: true, prf: true };
    if (caps.prf === false) return { credentials: true, prf: false };
    return { credentials: true, prf: null };
  } catch {
    return { credentials: true, prf: null };
  }
}

/** Profile-menu block. Renders nothing until an e2e session is unlocked. */
export function E2eMenu() {
  const status = useSyncExternalStore(subscribeE2eSession, getE2eSyncStatus, () => "idle" as const);
  const session = useSyncExternalStore(subscribeE2eSession, getE2eSession, () => null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  if (!session) return null;

  const download = async () => {
    const current = getE2eSession();
    if (!current) return;
    try {
      const [{ buildRecoveryKit }, { downloadKit }, { fromStoredWrap }, { validateWrap }] = await Promise.all([
        import("@/lib/crypto/kit"),
        import("@/lib/crypto/kit-browser"),
        import("@/lib/e2e/wraps"),
        import("@/lib/e2e-server"),
      ]);
      const validated = validateWrap(current.passwordWrap, "password");
      if (!validated.ok) {
        setNote("No se pudo armar el kit.");
        return;
      }
      const wrap = fromStoredWrap(current.passwordWrapId, current.userId, validated.wrap, null);
      const kit = buildRecoveryKit({
        email: current.email,
        createdAt: new Date(current.createdAt),
        passwordWrap: wrap,
        appUrl: window.location.origin,
      });
      downloadKit(kit);
      setNote("");
    } catch {
      setNote("No se pudo armar el kit.");
    }
  };

  const startAdd = async () => {
    const detected = await detectPasskey();
    if (!passkeySelectable(detected)) {
      setNote(passkeyNote(detected));
      setOpen(false);
      return;
    }
    setNote("");
    setOpen(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const current = getE2eSession();
    if (!current || busy || password.length === 0) return;
    setBusy(true);
    try {
      const [{ addPasskeyWrap }, { vault }, { fromStoredWrap, toStoredWrap }, { validateWrap }] = await Promise.all([
        import("@/lib/crypto/vault"),
        import("@/lib/crypto/dek"),
        import("@/lib/e2e/wraps"),
        import("@/lib/e2e-server"),
      ]);
      if (!vault.isUnlocked()) {
        setNote("Desbloqueá la cuenta primero.");
        return;
      }
      const validated = validateWrap(current.passwordWrap, "password");
      if (!validated.ok) {
        setNote("No se pudo agregar la passkey.");
        return;
      }
      const passwordWrap = fromStoredWrap(current.passwordWrapId, current.userId, validated.wrap, null);
      const passkeyWrapId = crypto.randomUUID();
      let created;
      try {
        created = await addPasskeyWrap({
          wraps: { password: passwordWrap },
          password,
          ctx: { userId: current.userId, wrapId: current.passwordWrapId },
          passkeyWrapId,
          userName: current.name || current.email,
          rpId: window.location.hostname,
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          credentials: navigator.credentials as CredentialsLike,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "PrfUnsupportedError" || name === "NotAllowedError" || name === "AbortError") {
          setNote(PASSKEY_NO_PRF);
          return;
        }
        if (name === "DecryptError") {
          setNote(WRONG_PASSWORD);
          return;
        }
        setNote("No se pudo agregar la passkey.");
        return;
      }
      const stored = toStoredWrap(created);
      let response: Response;
      try {
        response = await fetch("/api/e2e/keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "passkey", wrap: stored.wrap, id: passkeyWrapId, credentialId: stored.credentialId }),
          cache: "no-store",
        });
      } catch {
        setNote("No hay conexión. Probá de nuevo.");
        return;
      }
      if (!response.ok) {
        setNote("No se pudo guardar la passkey.");
        return;
      }
      setPassword("");
      setOpen(false);
      setNote("Passkey guardada en este dispositivo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="e2e-menu">
      <p className="e2e-menu-title">{COPY.menuTitle}</p>
      <p className="e2e-sync" role="status">{syncStatusText(status)}</p>
      <button type="button" className="e2e-btn profile-menu-item" onClick={() => void download()}>{COPY.menuDownload}</button>
      <button type="button" className="e2e-btn profile-menu-item" disabled={busy} onClick={() => void startAdd()}>{COPY.menuPasskey}</button>
      {open && (
        <form onSubmit={(event) => void save(event)}>
          <p className="e2e-note">{ADD_PASSKEY_NOTE}</p>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            spellCheck={false}
            aria-label={COPY.passwordLabel}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" className="e2e-btn" disabled={busy || password.length === 0}>{busy ? COPY.deriving : COPY.menuPasskeySave}</button>
        </form>
      )}
      {note && <p className="e2e-note" role="status">{note}</p>}
    </div>
  );
}
