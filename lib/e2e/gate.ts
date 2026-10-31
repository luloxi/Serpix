import { passwordMatchesUserIdentity } from "../crypto/password.ts";

// Pure gate for encrypted accounts. No DOM, no network, no engine import.
// Admin never mounts this. Invitees either onboard, unlock, or stay on the server
// workspace when they already have plaintext rows.

export const WRONG_PASSWORD = "Contraseña incorrecta";
export const LOAD_ERROR = "No se pudo consultar el cifrado. Revisá la conexión.";
export const ACTIVATE_FAILED = "No se pudo activar el cifrado.";
export const UNLOCK_FAILED = "No se pudo desbloquear.";
export const PASSKEY_FALLBACK = "No se pudo usar la passkey. Ingresá la contraseña de recuperación.";
export const PASSKEY_NO_PRF = "La passkey no devolvió PRF. El cifrado queda solo con la contraseña.";
export const PASSKEY_UNSUPPORTED = "Este navegador no puede crear una passkey con PRF. Seguimos solo con la contraseña.";
export const PASSKEY_SAVE_FAILED = "La passkey no se guardó. El cifrado quedó con la contraseña.";
export const KIT_BLOCKED = "El navegador bloqueó la ventana de impresión.";
export const FORGOT_PASSWORD = "Sin la contraseña de recuperación o la passkey no hay forma de recuperar los datos. El kit tiene la clave protegida con la contraseña, no la contraseña.";
export const REMEMBER_NOTE = "Guarda la clave en el almacenamiento de este navegador, cifrada, hasta que cierres sesión.";
export const ADD_PASSKEY_NOTE = "Para agregar la passkey hace falta la contraseña de recuperación. La clave en memoria no se puede copiar.";
export const BOOT_FAILED = "No se pudo abrir el espacio cifrado. Reintentá.";

export const COPY = {
  onboardingTitle: "Activá tu cifrado",
  onboardingBody: "Tus datos se cifran en este navegador antes de salir. El servidor guarda el texto cifrado y no puede leerlo. También ve, entre otras cosas, los identificadores y las fechas de creación y de modificación. En presupuestos y facturas ve el tipo de documento, el número, el estado y la fecha de vencimiento. Si pedís la lectura con IA, ve el texto de ese ticket.",
  onboardingNeed: "Para abrirlos más adelante necesitás la contraseña de recuperación o la passkey de un dispositivo. Si perdés las dos, no hay forma de recuperar los datos.",
  onboardingAi: "La lectura de tickets con IA manda ese ticket en claro, y solo si lo pedís en ese ticket. Esto no es una factura de ARCA.",
  passwordLabel: "Contraseña de recuperación",
  confirmLabel: "Repetí la contraseña",
  showPassword: "Mostrar",
  hidePassword: "Ocultar",
  passkeyLabel: "Agregar passkey de este dispositivo",
  understood: "Entiendo que si pierdo la contraseña y el passkey no se pueden recuperar mis datos",
  activate: "Activar cifrado",
  deriving: "Derivando clave…",
  kitTitle: "Guardá el kit de recuperación",
  kitBody: "El kit no tiene la contraseña ni la clave de los datos. Guardalo en un lugar seguro. Sin la contraseña, el archivo no alcanza para leer nada.",
  downloadKit: "Descargar kit",
  printKit: "Imprimir",
  kitSaved: "Ya guardé el kit",
  unlockTitle: "Desbloqueá tu cuenta",
  unlockPasskey: "Desbloquear con passkey",
  unlockPassword: "Desbloquear",
  remember: "Recordar en este dispositivo",
  forgot: "Olvidé mi contraseña",
  retry: "Reintentar",
  menuTitle: "Cifrado activo",
  menuDownload: "Descargar kit de recuperación",
  menuPasskey: "Agregar passkey",
  menuPasskeySave: "Guardar passkey",
  synced: "Sincronizado",
  syncing: "Sincronizando…",
  offline: "Sin conexión, cambios pendientes",
} as const;

const STRENGTH = ["Muy débil", "Débil", "Regular", "Fuerte", "Muy fuerte"] as const;

const ISSUE: Record<string, string> = {
  "too-short": "Tiene que tener al menos 12 caracteres.",
  common: "Es una contraseña muy común.",
  repeated: "Repite el mismo carácter varias veces seguidas.",
  sequential: "Tiene una secuencia fácil de adivinar.",
  "user-input": "No uses tu email ni tu nombre.",
  "low-score": "Es demasiado débil: hace falta más longitud o más variedad.",
};

export type GatePhase =
  | "loading"
  | "load-error"
  | "legacy"
  | "onboarding"
  | "deriving"
  | "kit"
  | "unlock"
  | "unlocking"
  | "ready";

export type GateState = {
  phase: GatePhase;
  legacyData: boolean;
  hasPasskey: boolean;
  message: string;
  autoUnlocked: boolean;
};

export type GateEvent =
  | { type: "loaded"; mode: "server" | "e2e"; legacyData: boolean; hasPasskey: boolean; cachedDek: boolean; message?: string }
  | { type: "legacy-blocked" }
  | { type: "load-failed" }
  | { type: "retry" }
  | { type: "derive" }
  | { type: "derive-done"; message?: string }
  | { type: "derive-failed"; message: string }
  | { type: "kit-saved" }
  | { type: "unlock" }
  | { type: "unlocked" }
  | { type: "bad-password" }
  | { type: "passkey-fallback"; message: string }
  | { type: "unlock-failed"; message: string }
  | { type: "boot-failed"; message: string };

export function initialGate(): GateState {
  return { phase: "loading", legacyData: false, hasPasskey: false, message: "", autoUnlocked: false };
}

/**
 * Admin skips the gate entirely (today's Workspace, no local fetch).
 * A non-admin mounts it for onboarding (server mode) or for the local engine (e2e).
 * `encryptionMode === "e2e"` is the same condition as shouldUseLocalEngine for a non-admin.
 */
export function shouldMountGate(input: { role?: string | null; encryptionMode?: string | null }): boolean {
  if (input.role === "admin") return false;
  const usesLocalEngine = input.encryptionMode === "e2e";
  const onboarding = input.role !== "admin";
  return usesLocalEngine || onboarding;
}

/** Where the keys response (plus the device cache) sends a session. Admin is never mounted. */
export function decideGate(input: {
  role?: string | null;
  mode?: string | null;
  legacyData: boolean;
  cachedDek: boolean;
}): "admin" | "legacy" | "onboarding" | "auto-unlock" | "unlock" {
  if (input.role === "admin") return "admin";
  if (input.mode === "e2e") return input.cachedDek ? "auto-unlock" : "unlock";
  if (input.legacyData) return "legacy";
  return "onboarding";
}

export function reduceGate(state: GateState, event: GateEvent): GateState {
  switch (event.type) {
    case "loaded": {
      if (state.phase !== "loading") return state;
      const next = decideGate({ role: "user", mode: event.mode, legacyData: event.legacyData, cachedDek: event.cachedDek });
      if (next === "legacy") return { phase: "legacy", legacyData: true, hasPasskey: false, message: "", autoUnlocked: false };
      if (next === "onboarding") return { phase: "onboarding", legacyData: false, hasPasskey: false, message: "", autoUnlocked: false };
      if (next === "auto-unlock") return { phase: "ready", legacyData: event.legacyData, hasPasskey: event.hasPasskey, message: "", autoUnlocked: true };
      return { phase: "unlock", legacyData: event.legacyData, hasPasskey: event.hasPasskey, message: event.message ?? "", autoUnlocked: false };
    }
    case "legacy-blocked":
      if (state.phase !== "deriving" && state.phase !== "onboarding") return state;
      return { phase: "legacy", legacyData: true, hasPasskey: false, message: "", autoUnlocked: false };
    case "load-failed":
      if (state.phase !== "loading") return state;
      return { ...state, phase: "load-error", message: LOAD_ERROR };
    case "retry":
      if (state.phase !== "load-error") return state;
      return { ...state, phase: "loading", message: "" };
    case "derive":
      if (state.phase === "onboarding") return { ...state, phase: "deriving", message: "" };
      return state;
    case "derive-done":
      if (state.phase !== "deriving") return state;
      return { ...state, phase: "kit", message: event.message ?? "" };
    case "derive-failed":
      if (state.phase !== "deriving") return state;
      return { ...state, phase: "onboarding", message: event.message };
    case "kit-saved":
      if (state.phase !== "kit") return state;
      return { ...state, phase: "ready", message: "" };
    case "unlock":
      if (state.phase !== "unlock") return state;
      return { ...state, phase: "unlocking", message: "" };
    case "unlocked":
      if (state.phase !== "unlocking" && state.phase !== "loading") return state;
      return { ...state, phase: "ready", message: "", autoUnlocked: state.phase === "loading" };
    case "bad-password":
      if (state.phase !== "unlocking") return state;
      return { ...state, phase: "unlock", message: WRONG_PASSWORD };
    case "passkey-fallback":
      if (state.phase !== "unlocking" && state.phase !== "unlock") return state;
      return { ...state, phase: "unlock", message: event.message };
    case "unlock-failed":
      if (state.phase !== "unlocking") return state;
      return { ...state, phase: "unlock", message: event.message };
    case "boot-failed":
      if (state.phase === "kit" || state.phase === "unlocking" || state.phase === "loading") {
        const phase = state.phase === "kit" ? "kit" : state.phase === "loading" ? "unlock" : "unlock";
        return { ...state, phase, message: event.message, autoUnlocked: false };
      }
      return state;
    default:
      return state;
  }
}

export type OnboardingCheck = {
  messages: string[];
  canSubmit: boolean;
  label: string;
  meter: number;
};

/**
 * Button stays disabled until the recovery password passes the same bar as
 * validateRecoveryPassword (12 code points and score >= 3, no composition rule),
 * the confirm matches, and the loss checkbox is on. `deriving` keeps the button
 * disabled while Argon2id runs.
 */
export function onboardingValidation(input: {
  score: number;
  issues: readonly string[];
  password: string;
  confirm: string;
  understood: boolean;
  deriving: boolean;
  length: number;
  /** Account email. Exact email / local-part / local-part-plus-digits cannot be submitted. */
  email?: string;
  userInputs?: readonly string[];
}): OnboardingCheck {
  const messages: string[] = [];
  for (const issue of input.issues) {
    const text = ISSUE[issue];
    if (text && !messages.includes(text)) messages.push(text);
  }
  if (input.length >= 12 && input.score < 3 && !input.issues.includes("low-score") && messages.length === 0) {
    messages.push(ISSUE["low-score"]);
  }
  if (input.confirm.length > 0 && input.confirm !== input.password) messages.push("Las contraseñas no coinciden.");
  const identityInputs = input.userInputs ?? (input.email ? [input.email] : []);
  const identity = identityInputs.length > 0 && passwordMatchesUserIdentity(input.password, identityInputs);
  if (identity && !messages.includes(ISSUE["user-input"])) messages.push(ISSUE["user-input"]);
  const meter = Math.max(0, Math.min(4, Math.trunc(input.score)));
  const canSubmit = !input.deriving
    && input.understood
    && input.length >= 12
    && input.score >= 3
    && !identity
    && !input.issues.includes("low-score")
    && input.password.length > 0
    && input.password === input.confirm;
  return { messages, canSubmit, label: STRENGTH[meter] ?? STRENGTH[0], meter };
}

export function activateButtonLabel(deriving: boolean): string {
  return deriving ? COPY.deriving : COPY.activate;
}

export type PasskeyCapability = { credentials: boolean; prf: boolean | null };

export function passkeyNote(cap: PasskeyCapability): string {
  if (!cap.credentials || cap.prf === false) return PASSKEY_UNSUPPORTED;
  return "";
}

export function passkeySelectable(cap: PasskeyCapability): boolean {
  return cap.credentials && cap.prf !== false;
}

/** Fixed Spanish text. A wrong password never includes the decrypt error. */
export function unlockFailure(kind: "password" | "passkey" | "other"): string {
  if (kind === "password") return WRONG_PASSWORD;
  if (kind === "passkey") return PASSKEY_FALLBACK;
  return UNLOCK_FAILED;
}

export function classifyUnlockError(error: unknown): "password" | "passkey" | "other" {
  const name = error instanceof Error ? error.name : "";
  if (name === "DecryptError") return "password";
  if (name === "PrfUnsupportedError" || name === "NotAllowedError" || name === "AbortError") return "passkey";
  return "other";
}

export function syncStatusText(status: string): string {
  if (status === "syncing" || status === "pending") return COPY.syncing;
  if (status === "offline" || status === "error") return COPY.offline;
  return COPY.synced;
}
