"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import Workspace from "@/app/workspace";
import { E2eMenu } from "@/app/e2e-menu";
import type { RecoveryKit } from "@/lib/crypto/kit";
import type { CredentialsLike } from "@/lib/crypto/passkey";
import { codePointLength, passwordStrength } from "@/lib/crypto/password";
import { activateE2eSession, clearE2eSession, getE2eSession, setE2eSyncStatus } from "@/lib/e2e/client-session";
import { LEGACY_DATA_ERROR, type KeyWrap } from "@/lib/e2e-server";
import {
  ACTIVATE_FAILED,
  BOOT_FAILED,
  COPY,
  FORGOT_PASSWORD,
  KIT_BLOCKED,
  PASSKEY_FALLBACK,
  PASSKEY_NO_PRF,
  PASSKEY_SAVE_FAILED,
  REMEMBER_NOTE,
  activateButtonLabel,
  classifyUnlockError,
  initialGate,
  onboardingValidation,
  passkeyNote,
  passkeySelectable,
  reduceGate,
  unlockFailure,
  type PasskeyCapability,
} from "@/lib/e2e/gate";

type Props = {
  userId: string;
  encryptionMode: "server" | "e2e";
  name: string;
  email: string;
  image: string | null;
};

type Held = {
  passwordWrapId: string;
  passwordWrap: KeyWrap;
  createdAt: number;
  passkeyWrapId: string | null;
  passkeyWrap: KeyWrap | null;
  passkeyCredentialId: string | null;
};

function isKeyWrap(value: unknown, type: "password" | "passkey"): value is KeyWrap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === type;
}

function readKeys(body: unknown): { mode: "server" | "e2e"; legacyData: boolean; held: Held | null; hasPasskey: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { mode?: unknown; legacyData?: unknown; wraps?: unknown };
  if ((row.mode !== "server" && row.mode !== "e2e") || !Array.isArray(row.wraps)) return null;
  let password: { id?: unknown; wrap?: unknown; createdAt?: unknown } | null = null;
  let passkey: { id?: unknown; wrap?: unknown; credentialId?: unknown } | null = null;
  for (const item of row.wraps) {
    if (!item || typeof item !== "object") continue;
    const wrap = item as { id?: unknown; type?: unknown; wrap?: unknown; credentialId?: unknown; createdAt?: unknown };
    if (wrap.type === "password" && !password) password = wrap;
    if (wrap.type === "passkey" && !passkey) passkey = wrap;
  }
  let held: Held | null = null;
  if (password && typeof password.id === "string" && isKeyWrap(password.wrap, "password")) {
    held = {
      passwordWrapId: password.id,
      passwordWrap: password.wrap,
      createdAt: typeof password.createdAt === "number" ? password.createdAt : Date.now(),
      passkeyWrapId: passkey && typeof passkey.id === "string" ? passkey.id : null,
      passkeyWrap: passkey && isKeyWrap(passkey.wrap, "passkey") ? passkey.wrap : null,
      passkeyCredentialId: passkey && typeof passkey.credentialId === "string" ? passkey.credentialId : null,
    };
  }
  return {
    mode: row.mode,
    legacyData: row.legacyData === true,
    held,
    hasPasskey: Boolean(held?.passkeyWrap && held.passkeyWrapId),
  };
}

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

async function postWrap(body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/e2e/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (response.status === 201) return { ok: true };
    let error = ACTIVATE_FAILED;
    try {
      const data = await response.json() as { error?: unknown };
      if (typeof data.error === "string" && data.error.length > 0 && data.error.length < 400) error = data.error;
    } catch { /* the generic line is enough */ }
    return { ok: false, error };
  } catch {
    return { ok: false, error: "No hay conexión. Probá de nuevo." };
  }
}

async function touchWrap(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await fetch("/api/e2e/keys/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ touch: true }),
      cache: "no-store",
    });
  } catch { /* opening the workspace does not depend on the timestamp */ }
}

export default function E2eGate({ userId, encryptionMode, name, email, image }: Props) {
  const [state, dispatch] = useReducer(reduceGate, undefined, initialGate);
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [wantPasskey, setWantPasskey] = useState(false);
  const [cap, setCap] = useState<PasskeyCapability>({ credentials: false, prf: null });
  const [remember, setRemember] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const [kitError, setKitError] = useState("");
  const held = useRef<Held | null>(null);
  const lock = useRef(false);
  const identity = useRef({ userId, email, name });
  useEffect(() => {
    identity.current = { userId, email, name };
  }, [userId, email, name]);

  const boot = async (dek: CryptoKey, isCancelled: () => boolean): Promise<boolean> => {
    const network = globalThis.fetch.bind(globalThis);
    let uninstall = () => {};
    let engine: { close: () => Promise<void>; pull: () => Promise<void>; push: () => Promise<void>; handle: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } | null = null;
    const [{ startEngine }, { installLocalFetch }, { fetchVendorWasm }] = await Promise.all([
      import("@/lib/e2e/engine"),
      import("@/lib/e2e/local-api"),
      import("@/lib/e2e/d1-local"),
    ]);
    const dropThis = async () => {
      try { uninstall(); } catch { /* the hook was not installed */ }
      try { await engine?.close(); } catch { /* already closed */ }
      if (getE2eSession()?.uninstall === uninstall) clearE2eSession();
    };
    const who = identity.current;
    try {
      const wasm = await fetchVendorWasm(network);
      if (isCancelled()) return false;
      engine = await startEngine({
        userId: who.userId,
        dek,
        fetch: network,
        wasm,
        name: who.name,
        email: who.email,
        role: "user",
        baseUrl: window.location.origin,
        installFetch: false,
        onStatus(next) { setE2eSyncStatus(next); },
      });
      const live = engine;
      uninstall = installLocalFetch({
        fetch: network,
        pull: () => live.pull(),
        push: () => live.push(),
        handle: (request) => live.handle(request),
      });
      const current = held.current;
      if (isCancelled() || !current) {
        await dropThis();
        return false;
      }
      activateE2eSession({
        userId: who.userId,
        email: who.email,
        name: who.name,
        passwordWrapId: current.passwordWrapId,
        passwordWrap: current.passwordWrap,
        createdAt: current.createdAt,
        uninstall,
        wipeVault: async () => {
          const { signOut } = await import("@/lib/crypto/vault");
          await signOut();
        },
        closeEngine: async () => {
          const { closeEngine } = await import("@/lib/e2e/engine");
          await closeEngine();
        },
      });
      if (isCancelled()) {
        await dropThis();
        return false;
      }
      return true;
    } catch {
      await dropThis();
      return false;
    }
  };

  useEffect(() => {
    let cancel = false;
    const stopped = () => cancel;
    void (async () => {
      let response: Response;
      try {
        response = await fetch("/api/e2e/keys", { cache: "no-store" });
      } catch {
        if (!stopped()) dispatch({ type: "load-failed" });
        return;
      }
      if (stopped()) return;
      if (!response.ok) {
        dispatch({ type: "load-failed" });
        return;
      }
      let body: unknown;
      try { body = await response.json(); } catch {
        if (!stopped()) dispatch({ type: "load-failed" });
        return;
      }
      const keys = readKeys(body);
      if (!keys) {
        if (!stopped()) dispatch({ type: "load-failed" });
        return;
      }
      if (keys.held) held.current = keys.held;
      if (keys.mode === "e2e") {
        let raw: Uint8Array | null = null;
        try {
          const [{ loadCachedDek }, { importDek, vault }] = await Promise.all([
            import("@/lib/crypto/device-cache"),
            import("@/lib/crypto/dek"),
          ]);
          raw = await loadCachedDek({ userId });
          if (stopped()) return;
          if (raw) {
            const key = await importDek(raw);
            vault.set(key);
            const ok = await boot(key, stopped);
            if (stopped()) return;
            if (ok) {
              void touchWrap(keys.held?.passwordWrapId ?? null);
              dispatch({ type: "loaded", mode: "e2e", legacyData: keys.legacyData, hasPasskey: keys.hasPasskey, cachedDek: true });
              return;
            }
            vault.clear();
            dispatch({ type: "loaded", mode: "e2e", legacyData: keys.legacyData, hasPasskey: keys.hasPasskey, cachedDek: false, message: BOOT_FAILED });
            return;
          }
        } catch {
          if (!stopped()) {
            try {
              const { vault } = await import("@/lib/crypto/dek");
              vault.clear();
            } catch { /* the password form still works */ }
          }
        } finally {
          if (raw) {
            const { wipe } = await import("@/lib/crypto/bytes");
            wipe(raw);
          }
        }
      }
      if (stopped()) return;
      dispatch({ type: "loaded", mode: keys.mode, legacyData: keys.legacyData, hasPasskey: keys.hasPasskey, cachedDek: false });
    })();
    return () => { cancel = true; };
  }, [attempt, userId]);

  useEffect(() => {
    if (state.phase !== "onboarding") return;
    void detectPasskey().then((next) => setCap(next));
  }, [state.phase]);

  const strength = passwordStrength(password, [email, name]);
  const check = onboardingValidation({
    score: strength.score,
    issues: strength.issues,
    password,
    confirm,
    understood,
    deriving: state.phase === "deriving",
    length: codePointLength(password),
  });
  const passkeyHint = passkeyNote(cap);
  const canPasskey = passkeySelectable(cap);

  const activate = async () => {
    if (lock.current || state.phase !== "onboarding" || !check.canSubmit) return;
    lock.current = true;
    dispatch({ type: "derive" });
    const passwordId = crypto.randomUUID();
    const passkeyId = crypto.randomUUID();
    const usePasskey = wantPasskey && canPasskey && !!navigator.credentials;
    try {
      const { createVault, signOut } = await import("@/lib/crypto/vault");
      let result;
      try {
        result = await createVault({
          userId,
          email,
          password,
          passkey: usePasskey ? {
            userName: name || email,
            rpId: window.location.hostname,
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            credentials: navigator.credentials as CredentialsLike,
          } : undefined,
          wrapIds: { password: passwordId, passkey: usePasskey ? passkeyId : undefined },
          deps: { appUrl: window.location.origin, remember: false },
        });
      } catch (error) {
        await signOut().catch(() => undefined);
        const kind = classifyUnlockError(error);
        dispatch({
          type: "derive-failed",
          message: usePasskey && kind === "passkey"
            ? "No se pudo crear la passkey. Desmarcá la opción y activá solo con la contraseña."
            : ACTIVATE_FAILED,
        });
        return;
      }
      const { toStoredWrap } = await import("@/lib/e2e/wraps");
      const storedPassword = toStoredWrap(result.wraps.password);
      const posted = await postWrap({ type: "password", wrap: storedPassword.wrap, id: passwordId });
      if (!posted.ok) {
        await signOut().catch(() => undefined);
        if (posted.error === LEGACY_DATA_ERROR) {
          dispatch({ type: "legacy-blocked" });
          return;
        }
        dispatch({ type: "derive-failed", message: posted.error });
        return;
      }
      let note = "";
      if (result.wraps.passkey) {
        const storedPasskey = toStoredWrap(result.wraps.passkey);
        const saved = await postWrap({
          type: "passkey",
          wrap: storedPasskey.wrap,
          id: passkeyId,
          credentialId: storedPasskey.credentialId,
        });
        if (!saved.ok) note = PASSKEY_SAVE_FAILED;
      } else if (usePasskey) {
        note = PASSKEY_NO_PRF;
      }
      held.current = {
        passwordWrapId: passwordId,
        passwordWrap: storedPassword.wrap,
        createdAt: Date.now(),
        passkeyWrapId: result.wraps.passkey ? passkeyId : null,
        passkeyWrap: null,
        passkeyCredentialId: null,
      };
      setKit(result.kit);
      setPassword("");
      setConfirm("");
      dispatch({ type: "derive-done", message: note });
    } finally {
      lock.current = false;
    }
  };

  const openVault = async (kind: "password" | "passkey") => {
    if (lock.current || state.phase !== "unlock") return;
    const current = held.current;
    if (!current) {
      dispatch({ type: "unlock-failed", message: unlockFailure("other") });
      return;
    }
    lock.current = true;
    dispatch({ type: "unlock" });
    try {
      const [{ unlockPasswordToRaw, unlockPasskeyToRaw }, { fromStoredWrap }, { importDek, vault }, { cacheDek }] = await Promise.all([
        import("@/lib/crypto/vault"),
        import("@/lib/e2e/wraps"),
        import("@/lib/crypto/dek"),
        import("@/lib/crypto/device-cache"),
      ]);
      const keep = remember === true;
      try {
        if (kind === "passkey") {
          if (!current.passkeyWrap || !current.passkeyWrapId || !navigator.credentials) {
            dispatch({ type: "passkey-fallback", message: PASSKEY_FALLBACK });
            return;
          }
          const wrap = fromStoredWrap(current.passkeyWrapId, userId, current.passkeyWrap, current.passkeyCredentialId);
          await unlockPasskeyToRaw(wrap, { userId, wrapId: current.passkeyWrapId }, {
            credentials: navigator.credentials as CredentialsLike,
            rpId: window.location.hostname,
            challenge: crypto.getRandomValues(new Uint8Array(32)),
          }, async (raw) => {
            if (keep) await cacheDek({ dekRaw: raw, userId, remember: true });
            vault.set(await importDek(raw));
          });
        } else {
          const wrap = fromStoredWrap(current.passwordWrapId, userId, current.passwordWrap, null);
          await unlockPasswordToRaw(wrap, password, { userId, wrapId: current.passwordWrapId }, async (raw) => {
            if (keep) await cacheDek({ dekRaw: raw, userId, remember: true });
            vault.set(await importDek(raw));
          });
        }
      } catch (error) {
        vault.clear();
        const failure = classifyUnlockError(error);
        if (kind === "passkey" || failure === "passkey") dispatch({ type: "passkey-fallback", message: PASSKEY_FALLBACK });
        else if (failure === "password") dispatch({ type: "bad-password" });
        else dispatch({ type: "unlock-failed", message: unlockFailure("other") });
        return;
      }
      const dek = vault.get();
      const ok = await boot(dek, () => false);
      if (!ok) {
        vault.clear();
        dispatch({ type: "boot-failed", message: BOOT_FAILED });
        return;
      }
      void touchWrap(kind === "passkey" ? current.passkeyWrapId : current.passwordWrapId);
      setPassword("");
      dispatch({ type: "unlocked" });
    } finally {
      lock.current = false;
    }
  };

  const confirmKit = async () => {
    if (lock.current || state.phase !== "kit" || !kit) return;
    lock.current = true;
    try {
      const { vault } = await import("@/lib/crypto/dek");
      let dek: CryptoKey;
      try { dek = vault.get(); } catch {
        dispatch({ type: "boot-failed", message: BOOT_FAILED });
        return;
      }
      const ok = await boot(dek, () => false);
      if (!ok) {
        dispatch({ type: "boot-failed", message: BOOT_FAILED });
        return;
      }
      setKit(null);
      dispatch({ type: "kit-saved" });
    } finally {
      lock.current = false;
    }
  };

  const saveKit = async (kind: "download" | "print") => {
    if (!kit) return;
    try {
      if (kind === "download") {
        const { downloadKit } = await import("@/lib/crypto/kit-browser");
        downloadKit(kit);
      } else {
        const { printKit } = await import("@/lib/crypto/kit-browser");
        printKit(kit);
      }
    } catch {
      setKitError(KIT_BLOCKED);
    }
  };

  if (state.phase === "legacy") {
    return (
      <div className="e2e-legacy-wrap">
        <p className="e2e-legacy" role="status">{LEGACY_DATA_ERROR}</p>
        <Workspace name={name} email={email} image={image} isAdmin={false} />
      </div>
    );
  }

  if (state.phase === "ready") {
    return <Workspace name={name} email={email} image={image} isAdmin={false} e2e e2eMenu={<E2eMenu />} />;
  }

  const deriving = state.phase === "deriving";
  const unlocking = state.phase === "unlocking";
  const loadingText = encryptionMode === "e2e" ? "Abriendo el cifrado…" : "Cargando el cifrado…";

  return (
    <div className="e2e-screen e2e-gate">
      <section className="e2e-card" aria-busy={deriving || unlocking || state.phase === "loading"}>
        {state.phase === "loading" && <p className="e2e-loading" role="status">{loadingText}</p>}
        {state.phase === "load-error" && (
          <>
            <h1>Cifrado</h1>
            <p role="alert">{state.message}</p>
            <button type="button" className="e2e-btn" onClick={() => { dispatch({ type: "retry" }); setAttempt((n) => n + 1); }}>{COPY.retry}</button>
          </>
        )}
        {(state.phase === "onboarding" || deriving) && (
          <>
            <h1>{COPY.onboardingTitle}</h1>
            <p>{COPY.onboardingBody}</p>
            <p>{COPY.onboardingNeed}</p>
            <p>{COPY.onboardingAi}</p>
            <form className="e2e-form" onSubmit={(event) => { event.preventDefault(); void activate(); }}>
              <label className="e2e-field">
                <span>{COPY.passwordLabel}</span>
                <span className="e2e-field-row">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={deriving}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button type="button" className="e2e-btn secondary" disabled={deriving} onClick={() => setShowPassword((v) => !v)}>{showPassword ? COPY.hidePassword : COPY.showPassword}</button>
                </span>
              </label>
              {password.length > 0 && (
                <div>
                  <div className="e2e-meter" role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={check.meter} aria-label={"Fortaleza: " + check.label}>
                    {[0, 1, 2, 3].map((bar) => <i key={bar} className={bar < check.meter ? "on" : ""} />)}
                  </div>
                  <p className="e2e-meter-label">{check.label}</p>
                </div>
              )}
              {password.length > 0 && check.messages.length > 0 && (
                <ul className="e2e-issues">
                  {check.messages.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              <label className="e2e-field">
                <span>{COPY.confirmLabel}</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="off"
                  disabled={deriving}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </label>
              <label className="e2e-check">
                <input type="checkbox" checked={wantPasskey} disabled={deriving || !canPasskey} onChange={(event) => setWantPasskey(event.target.checked)} />
                <span>{COPY.passkeyLabel}</span>
              </label>
              {passkeyHint && <p className="e2e-note">{passkeyHint}</p>}
              <label className="e2e-check">
                <input type="checkbox" checked={understood} disabled={deriving} onChange={(event) => setUnderstood(event.target.checked)} />
                <span>{COPY.understood}</span>
              </label>
              {state.message && <p className="e2e-warn" role="alert">{state.message}</p>}
              <button type="submit" className="e2e-btn" disabled={!check.canSubmit}>{activateButtonLabel(deriving)}</button>
            </form>
          </>
        )}
        {state.phase === "kit" && (
          <>
            <h1>{COPY.kitTitle}</h1>
            <p>{COPY.kitBody}</p>
            {(state.message || kitError) && <p className="e2e-note" role="status">{kitError || state.message}</p>}
            <div className="e2e-actions">
              <button type="button" className="e2e-btn secondary" onClick={() => void saveKit("download")}>{COPY.downloadKit}</button>
              <button type="button" className="e2e-btn secondary" onClick={() => void saveKit("print")}>{COPY.printKit}</button>
              <button type="button" className="e2e-btn" onClick={() => void confirmKit()}>{COPY.kitSaved}</button>
            </div>
          </>
        )}
        {(state.phase === "unlock" || unlocking) && (
          <>
            <h1>{COPY.unlockTitle}</h1>
            {state.hasPasskey && (
              <button type="button" className="e2e-btn" disabled={unlocking} onClick={() => void openVault("passkey")}>{COPY.unlockPasskey}</button>
            )}
            <form className="e2e-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void openVault("password"); }}>
              <label className="e2e-field">
                <span>{COPY.passwordLabel}</span>
                <span className="e2e-field-row">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    autoComplete="current-password"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={unlocking}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button type="button" className="e2e-btn secondary" disabled={unlocking} onClick={() => setShowPassword((v) => !v)}>{showPassword ? COPY.hidePassword : COPY.showPassword}</button>
                </span>
              </label>
              <label className="e2e-check">
                <input type="checkbox" checked={remember} disabled={unlocking} onChange={(event) => setRemember(event.target.checked)} />
                <span>{COPY.remember}</span>
                <small>{REMEMBER_NOTE}</small>
              </label>
              {state.message && <p className="e2e-warn" role="alert">{state.message}</p>}
              <button type="submit" className="e2e-btn" disabled={unlocking || password.length === 0}>{unlocking ? COPY.deriving : COPY.unlockPassword}</button>
            </form>
            <button type="button" className="e2e-btn e2e-text" onClick={() => setForgot((v) => !v)}>{COPY.forgot}</button>
            {forgot && <p>{FORGOT_PASSWORD}</p>}
          </>
        )}
      </section>
    </div>
  );
}
