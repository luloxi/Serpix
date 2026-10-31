import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEVICE_WIPE_WARNING, runSignOut, signOutWarning } from "../lib/e2e/sign-out.ts";
import { activateE2eSession, clearE2eSession, getE2eTeardown, isE2eActive, peekUninstall } from "../lib/e2e/client-session.ts";

test("sign-out wipes push, vault, fetch and the engine before the auth cookie", async () => {
  const order: string[] = [];
  const result = await runSignOut({
    removePush: async () => { order.push("push"); },
    e2eActive: true,
    wipeVault: async () => { order.push("vault"); },
    uninstallFetch: () => { order.push("fetch"); },
    closeEngine: async () => { order.push("engine"); },
    authSignOut: async () => { order.push("auth"); },
  });
  assert.deepEqual(order, ["push", "vault", "fetch", "engine", "auth"]);
  assert.equal(result.deviceWipeFailed, false);
  assert.equal(signOutWarning(result), null);
});

test("the open session's teardown is what sign-out runs", async () => {
  clearE2eSession();
  const order: string[] = [];
  activateE2eSession({
    userId: "ana",
    email: "ana@test.local",
    name: "Ana",
    passwordWrapId: "pw",
    passwordWrap: { v: 1 },
    createdAt: 1,
    uninstall: () => { order.push("fetch"); },
    wipeVault: async () => { order.push("vault"); },
    closeEngine: async () => { order.push("engine"); },
  });
  const teardown = getE2eTeardown();
  await runSignOut({
    removePush: async () => { order.push("push"); },
    e2eActive: isE2eActive(),
    wipeVault: () => teardown.wipeVault(),
    uninstallFetch: peekUninstall(),
    closeEngine: () => teardown.closeEngine(),
    authSignOut: async () => { order.push("auth"); },
  });
  assert.deepEqual(order, ["push", "vault", "fetch", "engine", "auth"]);
  clearE2eSession();
  const gone = getE2eTeardown();
  await gone.wipeVault();
  await gone.closeEngine();
  assert.deepEqual(order, ["push", "vault", "fetch", "engine", "auth"]);
});

test("a server session signs out without touching the vault", async () => {
  const order: string[] = [];
  const result = await runSignOut({
    removePush: async () => { order.push("push"); },
    e2eActive: false,
    wipeVault: async () => { order.push("vault"); },
    uninstallFetch: () => { order.push("fetch"); },
    closeEngine: async () => { order.push("engine"); },
    authSignOut: async () => { order.push("auth"); },
  });
  assert.deepEqual(order, ["push", "auth"]);
  assert.equal(result.deviceWipeFailed, false);
  assert.equal(signOutWarning(result), null);
});

test("a failed wipe still ends the session and is not a silent success", async () => {
  const order: string[] = [];
  const result = await runSignOut({
    removePush: async () => { order.push("push"); throw new Error("push"); },
    e2eActive: true,
    wipeVault: async () => { order.push("vault"); throw new Error("vault"); },
    uninstallFetch: () => { order.push("fetch"); throw new Error("fetch"); },
    closeEngine: async () => { order.push("engine"); throw new Error("engine"); },
    authSignOut: async () => { order.push("auth"); },
  });
  assert.deepEqual(order, ["push", "vault", "fetch", "engine", "auth"]);
  assert.equal(result.deviceWipeFailed, true);
  assert.equal(signOutWarning(result), DEVICE_WIPE_WARNING);
  assert.equal(DEVICE_WIPE_WARNING, "No pudimos borrar la clave de este dispositivo: cerrá las otras pestañas de Serpix y reintentá");
});

test("the button captures the e2e session before any await and does not wipe on pagehide", () => {
  const source = readFileSync(new URL("../app/sign-out-button.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("pagehide"), false);
  assert.equal(source.includes("signOutClearingPush"), false);
  const body = source.slice(source.indexOf("async function logout"));
  const active = body.indexOf("isE2eActive()");
  const uninstall = body.indexOf("peekUninstall()");
  const teardown = body.indexOf("getE2eTeardown()");
  const run = body.indexOf("runSignOut(");
  const clear = body.indexOf("clearE2eSession()");
  const warn = body.indexOf("signOutWarning(result)");
  const notify = body.indexOf("onWarning?.(message)");
  assert.ok(active > -1 && uninstall > active && teardown > uninstall && run > teardown && clear > run && warn > clear && notify > warn);
  assert.match(source, /role="alert"/);
  assert.match(source, /error-message/);
  const workspace = readFileSync(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<SignOutButton onWarning=\{setError\}\/>/);
  assert.equal(source.includes("@/lib/e2e/engine"), false);
  assert.equal(source.includes("@/lib/crypto/vault"), false);
  assert.match(source, /removeDevicePush/);
  clearE2eSession();
  assert.equal(isE2eActive(), false);
  let wiped = false;
  activateE2eSession({
    userId: "ana",
    email: "ana@test.local",
    name: "Ana",
    passwordWrapId: "pw",
    passwordWrap: { v: 1 },
    createdAt: 1,
    uninstall: () => { wiped = true; },
    wipeVault: async () => {},
    closeEngine: async () => {},
  });
  assert.equal(isE2eActive(), true);
  const uninstallFetch = peekUninstall();
  assert.equal(wiped, false);
  uninstallFetch();
  assert.equal(wiped, true);
  clearE2eSession();
  peekUninstall()();
  assert.equal(isE2eActive(), false);
});
