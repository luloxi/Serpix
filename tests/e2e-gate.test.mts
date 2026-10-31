import test from "node:test";
import assert from "node:assert/strict";
import { codePointLength, passwordStrength, validateRecoveryPassword, PasswordPolicyError } from "../lib/crypto/password.ts";
import { shouldUseLocalEngine } from "../lib/e2e/engine.ts";
import {
  BOOT_FAILED,
  COPY,
  FORGOT_PASSWORD,
  LOAD_ERROR,
  PASSKEY_FALLBACK,
  PASSKEY_UNSUPPORTED,
  REMEMBER_NOTE,
  WRONG_PASSWORD,
  activateButtonLabel,
  classifyUnlockError,
  decideGate,
  initialGate,
  onboardingValidation,
  passkeyNote,
  passkeySelectable,
  reduceGate,
  shouldMountGate,
  syncStatusText,
  unlockFailure,
  type GateEvent,
  type GateState,
} from "../lib/e2e/gate.ts";

function apply(events: GateEvent[], start: GateState = initialGate()): GateState {
  return events.reduce(reduceGate, start);
}

function check(password: string, extra: { confirm?: string; understood?: boolean; deriving?: boolean; userInputs?: string[] } = {}) {
  const strength = passwordStrength(password, extra.userInputs ?? []);
  return onboardingValidation({
    score: strength.score,
    issues: strength.issues,
    password,
    confirm: extra.confirm ?? password,
    understood: extra.understood ?? true,
    deriving: extra.deriving ?? false,
    length: codePointLength(password),
  });
}

test("admin never mounts the gate and the local engine only mounts for e2e invitees", () => {
  const roles = ["admin", "user", null, undefined, ""];
  const modes = ["server", "e2e", null, undefined, ""];
  for (const role of roles) {
    for (const encryptionMode of modes) {
      const input = { role, encryptionMode };
      if (shouldUseLocalEngine(input)) assert.equal(shouldMountGate(input), true, JSON.stringify(input));
      if (role === "admin") {
        assert.equal(shouldMountGate(input), false);
        assert.equal(shouldUseLocalEngine(input), false);
        assert.equal(decideGate({ role, mode: encryptionMode, legacyData: true, cachedDek: true }), "admin");
      }
    }
  }
  assert.equal(shouldMountGate({ role: "user", encryptionMode: "server" }), true);
  assert.equal(shouldUseLocalEngine({ role: "user", encryptionMode: "server" }), false);
  assert.equal(decideGate({ role: "user", mode: "server", legacyData: false, cachedDek: false }), "onboarding");
  assert.equal(decideGate({ role: "user", mode: "server", legacyData: true, cachedDek: true }), "legacy");
  assert.equal(decideGate({ role: "user", mode: "e2e", legacyData: true, cachedDek: false }), "unlock");
  assert.equal(decideGate({ role: "user", mode: "e2e", legacyData: true, cachedDek: true }), "auto-unlock");
});

test("gate transitions cover onboarding, legacy data, unlock and the device cache", () => {
  assert.equal(initialGate().phase, "loading");

  const onboarding = apply([{ type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false }]);
  assert.equal(onboarding.phase, "onboarding");
  assert.equal(onboarding.autoUnlocked, false);

  const ignored = reduceGate(onboarding, { type: "loaded", mode: "e2e", legacyData: false, hasPasskey: true, cachedDek: true });
  assert.equal(ignored.phase, "onboarding");

  const legacy = apply([{ type: "loaded", mode: "server", legacyData: true, hasPasskey: false, cachedDek: false }]);
  assert.deepEqual(legacy, { phase: "legacy", legacyData: true, hasPasskey: false, message: "", autoUnlocked: false });
  assert.equal(reduceGate(legacy, { type: "kit-saved" }).phase, "legacy");
  assert.equal(reduceGate(legacy, { type: "derive" }).phase, "legacy");

  const blocked = apply([
    { type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false },
    { type: "derive" },
    { type: "legacy-blocked" },
  ]);
  assert.equal(blocked.phase, "legacy");
  assert.equal(reduceGate(onboarding, { type: "legacy-blocked" }).phase, "legacy");
  assert.equal(reduceGate(apply([{ type: "loaded", mode: "e2e", legacyData: false, hasPasskey: false, cachedDek: false }]), { type: "legacy-blocked" }).phase, "unlock");

  const kit = apply([
    { type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false },
    { type: "derive" },
    { type: "derive-done", message: "nota" },
    { type: "kit-saved" },
  ]);
  assert.equal(apply([
    { type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false },
    { type: "derive" },
  ]).phase, "deriving");
  assert.equal(kit.phase, "ready");
  const failedDerive = apply([
    { type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false },
    { type: "derive" },
    { type: "derive-failed", message: "No se pudo activar el cifrado." },
  ]);
  assert.equal(failedDerive.phase, "onboarding");
  assert.equal(failedDerive.message, "No se pudo activar el cifrado.");

  const loadError = apply([{ type: "load-failed" }]);
  assert.equal(loadError.phase, "load-error");
  assert.equal(loadError.message, LOAD_ERROR);
  assert.equal(reduceGate(loadError, { type: "loaded", mode: "e2e", legacyData: false, hasPasskey: false, cachedDek: false }).phase, "load-error");
  assert.equal(reduceGate(onboarding, { type: "retry" }).phase, "onboarding");
  const retried = reduceGate(loadError, { type: "retry" });
  assert.equal(retried.phase, "loading");
  assert.equal(retried.message, "");

  const cached = apply([{ type: "loaded", mode: "e2e", legacyData: false, hasPasskey: true, cachedDek: true }]);
  assert.equal(cached.phase, "ready");
  assert.equal(cached.autoUnlocked, true);
  assert.equal(cached.hasPasskey, true);
  const fromLoading = reduceGate(initialGate(), { type: "unlocked" });
  assert.equal(fromLoading.phase, "ready");
  assert.equal(fromLoading.autoUnlocked, true);

  const locked = apply([{ type: "loaded", mode: "e2e", legacyData: true, hasPasskey: true, cachedDek: false, message: "" }]);
  assert.equal(locked.phase, "unlock");
  assert.equal(locked.legacyData, true);
  assert.equal(locked.hasPasskey, true);
  const wrong = apply([{ type: "unlock" }, { type: "bad-password" }], locked);
  assert.equal(wrong.phase, "unlock");
  assert.equal(wrong.message, WRONG_PASSWORD);
  assert.equal(wrong.message, "Contraseña incorrecta");
  assert.equal(wrong.message.includes("Decrypt"), false);

  const fallback = apply([{ type: "unlock" }, { type: "passkey-fallback", message: PASSKEY_FALLBACK }], locked);
  assert.equal(fallback.phase, "unlock");
  assert.equal(fallback.message, PASSKEY_FALLBACK);
  const directFallback = reduceGate(locked, { type: "passkey-fallback", message: PASSKEY_FALLBACK });
  assert.equal(directFallback.message, PASSKEY_FALLBACK);

  const other = apply([{ type: "unlock" }, { type: "unlock-failed", message: "No se pudo desbloquear." }], locked);
  assert.equal(other.phase, "unlock");
  const opened = apply([{ type: "unlock" }, { type: "unlocked" }], locked);
  assert.equal(opened.phase, "ready");
  assert.equal(opened.autoUnlocked, false);

  const kitBoot = apply([
    { type: "loaded", mode: "server", legacyData: false, hasPasskey: false, cachedDek: false },
    { type: "derive" },
    { type: "derive-done" },
    { type: "boot-failed", message: BOOT_FAILED },
  ]);
  assert.equal(kitBoot.phase, "kit");
  assert.equal(kitBoot.message, BOOT_FAILED);
  const unlockBoot = apply([{ type: "unlock" }, { type: "boot-failed", message: BOOT_FAILED }], locked);
  assert.equal(unlockBoot.phase, "unlock");
  const loadingBoot = reduceGate(initialGate(), { type: "boot-failed", message: BOOT_FAILED });
  assert.equal(loadingBoot.phase, "unlock");
  assert.equal(reduceGate(opened, { type: "boot-failed", message: BOOT_FAILED }).phase, "ready");
});

test("onboarding stays disabled until the recovery password, the confirm and the checkbox are valid", () => {
  const short = check("clave");
  assert.equal(short.canSubmit, false);
  assert.ok(short.messages.includes("Tiene que tener al menos 12 caracteres."));
  assert.equal(short.label, "Muy débil");

  const common = check("administrador");
  assert.equal(common.canSubmit, false);
  assert.ok(common.messages.includes("Es una contraseña muy común."));

  const repeated = check("aaaaaaaaaaaa");
  assert.equal(repeated.canSubmit, false);
  assert.ok(repeated.messages.includes("Repite el mismo carácter varias veces seguidas."));

  const sequential = check("Abcdefghijkl");
  assert.equal(sequential.canSubmit, false);
  assert.ok(sequential.messages.includes("Tiene una secuencia fácil de adivinar."));

  const personal = check("luciano-serpix", { userInputs: ["luciano@example.com"] });
  assert.equal(personal.canSubmit, false);
  assert.ok(personal.messages.includes("No uses tu email ni tu nombre."));

  const emoji = check("😀".repeat(6));
  assert.equal(emoji.canSubmit, false);
  assert.ok(emoji.messages.includes("Tiene que tener al menos 12 caracteres."));

  const mismatch = check("Correct-Horse-99", { confirm: "Correct-Horse-98" });
  assert.equal(mismatch.canSubmit, false);
  assert.ok(mismatch.messages.includes("Las contraseñas no coinciden."));
  assert.equal(mismatch.label, "Muy fuerte");
  assert.equal(mismatch.meter, 4);

  const unchecked = check("Correct-Horse-99", { understood: false });
  assert.equal(unchecked.canSubmit, false);
  assert.deepEqual(unchecked.messages, []);

  const emptyConfirm = check("Correct-Horse-99", { confirm: "" });
  assert.equal(emptyConfirm.canSubmit, false);
  assert.deepEqual(emptyConfirm.messages, []);

  const fair = check("opasopasopas");
  assert.equal(fair.canSubmit, false);
  assert.equal(fair.label, "Regular");
  assert.equal(fair.meter, 2);
  assert.ok(fair.messages.includes("Usá al menos dos tipos de caracteres."));
  assert.ok(fair.messages.includes("Es demasiado débil: hace falta más longitud o más variedad."));

  const lower12 = check("xkcdpassworx");
  assert.equal(lower12.canSubmit, false);
  assert.ok(lower12.messages.includes("Usá al menos dos tipos de caracteres."));

  const twoClass = check("CorrectHorse");
  assert.equal(twoClass.canSubmit, false);
  assert.ok(twoClass.messages.includes("Es demasiado débil: hace falta más longitud o más variedad."));
  assert.equal(twoClass.messages.includes("Usá al menos dos tipos de caracteres."), false);

  const threeClasses = check("BlueHorse99x");
  assert.equal(threeClasses.canSubmit, true);
  assert.equal(threeClasses.meter, 3);
  assert.deepEqual(threeClasses.messages, []);

  const lower16 = check("opasopasopasopas");
  assert.equal(lower16.canSubmit, false);
  assert.equal(lower16.meter, 3);
  assert.deepEqual(lower16.messages, ["Usá al menos dos tipos de caracteres."]);

  const phrase = check("correct horse bat");
  assert.equal(phrase.canSubmit, true);
  assert.equal(phrase.meter, 3);
  assert.deepEqual(phrase.messages, []);

  const strong = check("Correct-Horse-99");
  assert.equal(strong.canSubmit, true);
  assert.equal(activateButtonLabel(false), COPY.activate);
  const deriving = check("Correct-Horse-99", { deriving: true });
  assert.equal(deriving.canSubmit, false);
  assert.equal(activateButtonLabel(true), COPY.deriving);

  const stillShown = check("Correct-Horse-9999");
  assert.equal(stillShown.canSubmit, true);
  assert.ok(stillShown.messages.includes("Repite el mismo carácter varias veces seguidas."));

  const weakOnly = onboardingValidation({ score: 1, issues: [], password: "x".repeat(12), confirm: "x".repeat(12), understood: true, deriving: false, length: 12 });
  assert.equal(weakOnly.canSubmit, false);
  assert.deepEqual(weakOnly.messages, ["Es demasiado débil: hace falta más longitud o más variedad."]);
  assert.equal(weakOnly.label, "Débil");

  const fairOnly = onboardingValidation({ score: 2, issues: [], password: "x".repeat(12), confirm: "x".repeat(12), understood: true, deriving: false, length: 12 });
  assert.equal(fairOnly.canSubmit, false);
  assert.deepEqual(fairOnly.messages, ["Es demasiado débil: hace falta más longitud o más variedad."]);

  const oneClass = onboardingValidation({
    score: 3,
    issues: ["single-class"],
    password: "o".repeat(16),
    confirm: "o".repeat(16),
    understood: true,
    deriving: false,
    length: 16,
  });
  assert.equal(oneClass.canSubmit, false);
  assert.deepEqual(oneClass.messages, ["Usá al menos dos tipos de caracteres."]);
  assert.equal(oneClass.label, "Fuerte");

  const strongEnough = onboardingValidation({
    score: 3,
    issues: [],
    password: "correct horse bat",
    confirm: "correct horse bat",
    understood: true,
    deriving: false,
    length: 17,
  });
  assert.equal(strongEnough.canSubmit, true);
  assert.deepEqual(strongEnough.messages, []);
});

test("onboarding submit matches validateRecoveryPassword", () => {
  const samples: { password: string; userInputs?: string[] }[] = [
    { password: "clave" },
    { password: "xkcdpassworx" },
    { password: "opasopasopas" },
    { password: "opasopasopasopas" },
    { password: "CorrectHorse" },
    { password: "BlueHorse99x" },
    { password: "correct horse bat" },
    { password: "administrador" },
    { password: "Abcdefghijkl" },
    { password: "aaaaaaaaaaaa" },
    { password: "password1234" },
    { password: "Correct-Horse-99" },
    { password: "Áb1!Áb1!Áb1!" },
    { password: "luciano-serpix" },
    { password: "luciano-serpix", userInputs: ["luciano@example.com"] },
    { password: "Keep-luciano@example.com", userInputs: ["luciano@example.com"] },
  ];
  for (const sample of samples) {
    const ui = check(sample.password, { userInputs: sample.userInputs });
    let accepted = true;
    try {
      validateRecoveryPassword(sample.password, sample.userInputs);
    } catch (error) {
      assert.ok(error instanceof PasswordPolicyError);
      accepted = false;
    }
    assert.equal(ui.canSubmit, accepted, sample.password);
  }
});

test("unlock and passkey copy stays fixed and does not echo a decrypt error", () => {
  const decrypt = new Error("salt and dek leaked");
  decrypt.name = "DecryptError";
  assert.equal(classifyUnlockError(decrypt), "password");
  assert.equal(unlockFailure("password"), WRONG_PASSWORD);
  assert.equal(unlockFailure("password").includes("leaked"), false);
  for (const name of ["PrfUnsupportedError", "NotAllowedError", "AbortError"]) {
    const error = new Error("cancelled " + name);
    error.name = name;
    assert.equal(classifyUnlockError(error), "passkey");
  }
  assert.equal(unlockFailure("passkey"), PASSKEY_FALLBACK);
  assert.equal(classifyUnlockError(new Error("network")), "other");
  assert.equal(unlockFailure("other"), "No se pudo desbloquear.");
  assert.equal(passkeyNote({ credentials: false, prf: null }), PASSKEY_UNSUPPORTED);
  assert.equal(passkeyNote({ credentials: true, prf: false }), PASSKEY_UNSUPPORTED);
  assert.equal(passkeyNote({ credentials: true, prf: null }), "");
  assert.equal(passkeyNote({ credentials: true, prf: true }), "");
  assert.equal(passkeySelectable({ credentials: false, prf: true }), false);
  assert.equal(passkeySelectable({ credentials: true, prf: false }), false);
  assert.equal(passkeySelectable({ credentials: true, prf: null }), true);
  assert.equal(syncStatusText("idle"), COPY.synced);
  assert.equal(syncStatusText("syncing"), COPY.syncing);
  assert.equal(syncStatusText("pending"), "Sincronizando…");
  assert.equal(syncStatusText("offline"), COPY.offline);
  assert.equal(syncStatusText("error"), "Sin conexión, cambios pendientes");
  assert.equal(syncStatusText("other"), "Sincronizado");
  assert.equal(COPY.onboardingTitle, "Activá tu cifrado");
  assert.match(COPY.onboardingBody, /cifran en este navegador/);
  assert.match(COPY.onboardingNeed, /Si perdés las dos/);
  assert.match(COPY.onboardingAi, /no es una factura de ARCA/);
  assert.equal(COPY.understood, "Entiendo que si pierdo la contraseña y el passkey no se pueden recuperar mis datos");
  assert.equal(COPY.passkeyLabel, "Agregar passkey de este dispositivo");
  assert.equal(COPY.kitSaved, "Ya guardé el kit");
  assert.equal(COPY.unlockTitle, "Desbloqueá tu cuenta");
  assert.equal(COPY.unlockPasskey, "Desbloquear con passkey");
  assert.equal(COPY.remember, "Recordar en este dispositivo");
  assert.equal(REMEMBER_NOTE, "Guarda la clave en el almacenamiento de este navegador, cifrada, hasta que cierres sesión.");
  assert.match(FORGOT_PASSWORD, /no hay forma de recuperar/);
  assert.match(FORGOT_PASSWORD, /no la contraseña/);
  assert.equal(COPY.menuTitle, "Cifrado activo");
  assert.equal(COPY.menuDownload, "Descargar kit de recuperación");
  assert.equal(COPY.menuPasskey, "Agregar passkey");
  assert.equal(JSON.stringify(COPY).toLowerCase().includes("inhackeable"), false);
});

test("onboarding body names what the server can see and skips absolute claims", () => {
  const body = COPY.onboardingBody;
  assert.equal(body.includes(" solo guarda"), false);
  assert.match(body, /tipo/);
  assert.match(body, /número/);
  assert.match(body, /estado/);
  assert.match(body, /vencimiento/);
  assert.match(body, /IA/);
  assert.match(body, /ticket/);
  const folded = body.toLowerCase();
  assert.equal(folded.includes("nadie"), false);
  assert.equal(folded.includes("cuántic"), false);
  assert.equal(folded.includes("cuantic"), false);
  assert.equal(folded.includes("imposible"), false);
});
