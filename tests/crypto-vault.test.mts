// Vault orchestration. Argon2id runs for real; the timer is injected so the size stays 64 MiB.

import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { Vault } from "../lib/crypto/dek.ts";
import { DEVICE_DB_NAME, loadCachedDek } from "../lib/crypto/device-cache.ts";
import { openRecord, sealRecord } from "../lib/crypto/envelope.ts";
import { parseRecoveryKit } from "../lib/crypto/kit.ts";
import { PasswordPolicyError } from "../lib/crypto/password.ts";
import {
  addPasskeyWrap,
  createVault,
  signOut,
  unlockPasswordToRaw,
  unlockWithPasskey,
  unlockWithPassword,
  vault,
} from "../lib/crypto/vault.ts";
import { fakeAuthenticator } from "./helpers/fake-authenticator.ts";
import { bytesToHex, hexToBytes } from "./helpers/codec.ts";

const password = "Correct-Horse-99";
const email = "ada@example.com";
const userId = "user-1";
const appUrl = "https://serpix.example";
const createdAt = "2026-10-31T12:00:00.000Z";
const fast = { elapsed: () => 50 };
const recordCtx = { table: "contacts", id: "row-1", userId };
const secret = hexToBytes("2222222222222222222222222222222222222222222222222222222222222222");

function passkey(credentials: ReturnType<typeof fakeAuthenticator>) {
  return {
    userName: email,
    rpId: "serpix.example",
    challenge: new Uint8Array(32).fill(4),
    credentials,
  };
}

async function names(idb: IDBFactory): Promise<string[]> {
  const rows = await idb.databases();
  return rows.map((row) => row.name ?? "").filter((name) => name.length > 0);
}

test("password and passkey open the same record, including from the kit on a fresh device", { timeout: 300_000 }, async () => {
  const idb = new IDBFactory();
  const authenticator = fakeAuthenticator(secret, "prf");
  vault.clear();
  try {
    const created = await createVault({
      userId,
      email,
      password,
      passkey: passkey(authenticator),
      wrapIds: { password: "pw-1", passkey: "pk-1" },
      deps: { appUrl, createdAt, timer: fast, idb, remember: false },
    });
    assert.equal(vault.isUnlocked(), true);
    assert.ok(created.wraps.passkey);
    assert.deepEqual(await names(idb), []);
    assert.equal(created.kit.text.includes(password), false);
    assert.match(created.kit.text, /ada@example.com/);
    assert.match(created.kit.text, /para siempre/);

    const envelope = await sealRecord(created.dekKey, recordCtx, { name: "Ada", note: "Ñandú" });
    let leaked: Uint8Array | null = null;
    await unlockPasswordToRaw(created.wraps.password, password, { userId, wrapId: "pw-1" }, (raw) => {
      leaked = raw;
      assert.equal(raw.byteLength, 32);
    });
    assert.ok(leaked);
    assert.equal(bytesToHex(leaked), "00".repeat(32));

    vault.clear();
    const passwordKey = await unlockWithPassword(
      created.wraps,
      password,
      { userId, wrapId: "pw-1" },
    );
    assert.deepEqual(await openRecord(passwordKey, recordCtx, envelope), { name: "Ada", note: "Ñandú" });

    vault.clear();
    const passkeyKey = await unlockWithPasskey(
      created.wraps,
      { userId, wrapId: "pk-1" },
      { ...passkey(authenticator) },
    );
    assert.deepEqual(await openRecord(passkeyKey, recordCtx, envelope), { name: "Ada", note: "Ñandú" });

    const freshDb = new IDBFactory();
    const freshVault = new Vault();
    vault.clear();
    const fromKit = parseRecoveryKit(created.kit.text);
    const kitKey = await unlockWithPassword(
      { password: fromKit },
      password,
      { userId: fromKit.userId, wrapId: fromKit.wrapId },
      { vault: freshVault },
    );
    assert.equal(freshVault.isUnlocked(), true);
    assert.equal(vault.isUnlocked(), false);
    assert.deepEqual(await openRecord(kitKey, recordCtx, envelope), { name: "Ada", note: "Ñandú" });
    assert.deepEqual(await names(freshDb), []);
    assert.equal(await loadCachedDek({ userId, idb: freshDb }), null);
  } finally {
    vault.clear();
  }
});

test("a passkey without PRF falls back to the password, and a later passkey wrap matches", { timeout: 240_000 }, async () => {
  const idb = new IDBFactory();
  const blind = fakeAuthenticator(secret, "none");
  const holder = new Vault();
  try {
    const created = await createVault({
      userId,
      email,
      password,
      passkey: passkey(blind),
      wrapIds: { password: "pw-1", passkey: "pk-1" },
      deps: { appUrl, createdAt, timer: fast, idb, vault: holder, remember: false },
    });
    assert.equal(created.wraps.passkey, undefined);
    assert.equal(holder.isUnlocked(), true);
    assert.deepEqual(await names(idb), []);
    const envelope = await sealRecord(holder.get(), recordCtx, { ok: true });
    holder.clear();

    const roaming = fakeAuthenticator(secret, "prf");
    const passkeyWrap = await addPasskeyWrap({
      wraps: created.wraps,
      password,
      ctx: { userId, wrapId: "pw-1" },
      passkeyWrapId: "pk-2",
      userName: email,
      rpId: "serpix.example",
      challenge: new Uint8Array(32).fill(8),
      credentials: roaming,
    });
    const key = await unlockWithPasskey(
      { passkey: passkeyWrap },
      { userId, wrapId: "pk-2" },
      {
        credentials: roaming,
        rpId: "serpix.example",
        challenge: new Uint8Array(32).fill(8),
        vault: holder,
      },
    );
    assert.deepEqual(await openRecord(key, recordCtx, envelope), { ok: true });
  } finally {
    holder.clear();
    vault.clear();
  }
});

test("remember stores wrapped material and sign-out clears it", { timeout: 240_000 }, async () => {
  const idb = new IDBFactory();
  const holder = new Vault();
  try {
    const created = await createVault({
      userId,
      email,
      password,
      wrapIds: { password: "pw-1" },
      deps: { appUrl, createdAt, timer: fast, idb, vault: holder, remember: true },
    });
    assert.deepEqual(await names(idb), [DEVICE_DB_NAME]);
    const envelope = await sealRecord(holder.get(), recordCtx, { name: "Ada" });
    await signOut({ idb, vault: holder });
    assert.equal(holder.isUnlocked(), false);
    assert.deepEqual(await names(idb), []);
    assert.equal(await loadCachedDek({ userId, idb }), null);

    const key = await unlockWithPassword(created.wraps, password, { userId, wrapId: "pw-1" }, { vault: holder });
    assert.deepEqual(await openRecord(key, recordCtx, envelope), { name: "Ada" });
    assert.deepEqual(await names(idb), []);
  } finally {
    holder.clear();
    vault.clear();
  }
});

test("a weak recovery password is rejected before Argon2", async () => {
  const started = performance.now();
  await assert.rejects(
    () => createVault({
      userId,
      email,
      password: "administrador",
      wrapIds: { password: "pw-1" },
      deps: { appUrl, timer: fast },
    }),
    PasswordPolicyError,
  );
  assert.ok(performance.now() - started < 500);
});

test("a passkey ceremony error is not turned into a password-only vault", { timeout: 180_000 }, async () => {
  const holder = new Vault();
  await assert.rejects(
    () => createVault({
      userId,
      email,
      password,
      passkey: passkey({
        create: async () => {
          throw new Error("ceremony failed");
        },
        get: async () => null,
      }),
      wrapIds: { password: "pw-1", passkey: "pk-1" },
      deps: { appUrl, createdAt, timer: fast, vault: holder },
    }),
    /ceremony failed/,
  );
  assert.equal(holder.isUnlocked(), false);
});
