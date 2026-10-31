// Device cache. Default off. IndexedDB holds a non-extractable key and a wrapped DEK, never the raw DEK.

import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBVersionChangeEvent } from "fake-indexeddb";
import { bytesToBase64Url } from "../lib/crypto/bytes.ts";
import { importDek, Vault } from "../lib/crypto/dek.ts";
import { DEVICE_DB_NAME, DEVICE_WIPE_BLOCKED_MS, DeviceWipeBlockedError, cacheDek, clearDeviceCache, loadCachedDek } from "../lib/crypto/device-cache.ts";
import { DecryptError, openBytes, sealBytes } from "../lib/crypto/envelope.ts";
import { signOut, vault } from "../lib/crypto/vault.ts";
import { bytesToHex, hexToBytes } from "./helpers/codec.ts";

const userId = "user-1";
const dek = hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
const ctx = { table: "contacts", id: "row-1", userId };

async function names(idb: IDBFactory): Promise<string[]> {
  const rows = await idb.databases();
  return rows.map((row) => row.name ?? "").filter((name) => name.length > 0);
}

function holdOpen(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DEVICE_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
  });
}

function dump(db: IDBDatabase): Promise<Array<{ id?: string }>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const request = tx.objectStore("kv").getAll();
    request.onsuccess = () => resolve(request.result as Array<{ id?: string }>);
    request.onerror = () => reject(request.error ?? new Error("read failed"));
  });
}

async function settleDelete(db: IDBDatabase): Promise<void> {
  db.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function rows(idb: IDBFactory): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DEVICE_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const request = tx.objectStore("kv").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

test("remember false does not open IndexedDB", async () => {
  const idb = new IDBFactory();
  await cacheDek({ dekRaw: dek, userId, remember: false, idb });
  assert.deepEqual(await names(idb), []);
  assert.equal(await loadCachedDek({ userId, idb }), null);
  assert.deepEqual(await names(idb), []);
});

test("remember true stores a wrapped DEK and clear removes it", async () => {
  const idb = new IDBFactory();
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  assert.deepEqual(await names(idb), [DEVICE_DB_NAME]);
  const stored = await rows(idb);
  const encoded = JSON.stringify(stored, (_key, value) => {
    if (value instanceof CryptoKey) {
      return { extractable: value.extractable, name: (value.algorithm as AesKeyAlgorithm).name };
    }
    return value;
  });
  assert.equal(encoded.includes(bytesToHex(dek)), false);
  assert.equal(encoded.includes(bytesToBase64Url(dek)), false);
  assert.match(encoded, /"extractable":false/);
  assert.equal(await loadCachedDek({ userId: "someone-else", idb }), null);

  const loaded = await loadCachedDek({ userId, idb });
  assert.ok(loaded);
  assert.equal(bytesToHex(loaded), bytesToHex(dek));
  const key = await importDek(loaded);
  loaded.fill(0);
  const envelope = await sealBytes(key, ctx, Uint8Array.of(7, 8, 9));
  assert.deepEqual(await openBytes(key, ctx, envelope), Uint8Array.of(7, 8, 9));

  const dumped = await rows(idb);
  const dekRow = dumped.find((row) => {
    return typeof row === "object" && row !== null && (row as { id?: string }).id === "dek";
  }) as { c: string; n: string };
  const flipped = Uint8Array.from(Buffer.from(dekRow.c, "base64url"));
  flipped[0] ^= 0xff;
  dekRow.c = bytesToBase64Url(flipped);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DEVICE_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(dekRow);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await assert.rejects(() => loadCachedDek({ userId, idb }), DecryptError);

  await clearDeviceCache({ idb, blockedTimeoutMs: 200 });
  assert.deepEqual(await names(idb), []);
  assert.equal(await loadCachedDek({ userId, idb }), null);
});

test("signOut clears the vault and the device database", async () => {
  const idb = new IDBFactory();
  const holder = new Vault();
  holder.set(await importDek(dek));
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  vault.clear();
  await signOut({ idb, vault: holder, blockedTimeoutMs: 200 });
  assert.equal(holder.isUnlocked(), false);
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(await names(idb), []);
  await signOut({ idb, blockedTimeoutMs: 200 });
  assert.equal(vault.isUnlocked(), false);
});

test("a second open connection does not make a blocked wipe succeed", { timeout: 2_000 }, async () => {
  assert.equal(DEVICE_WIPE_BLOCKED_MS, 3000);
  const idb = new IDBFactory();
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  const other = await holdOpen(idb);
  try {
    assert.equal((await dump(other)).some((row) => row.id === "dek"), true);
    await assert.rejects(
      () => clearDeviceCache({ idb, blockedTimeoutMs: 80 }),
      (error: unknown) => error instanceof DeviceWipeBlockedError,
    );
    const left = await dump(other);
    assert.equal(left.some((row) => row.id === "dek" || row.id === "device-key"), false);
    assert.deepEqual(await names(idb), [DEVICE_DB_NAME]);
  } finally {
    await settleDelete(other);
  }
  assert.equal(await loadCachedDek({ userId, idb }), null);
  assert.deepEqual(await names(idb), []);
});

test("a wipe succeeds once the other connection closes", { timeout: 2_000 }, async () => {
  const idb = new IDBFactory();
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  const other = await holdOpen(idb);
  other.onversionchange = () => {
    setTimeout(() => other.close(), 60);
  };
  const started = Date.now();
  await clearDeviceCache({ idb, blockedTimeoutMs: 1_000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40, `wipe returned in ${elapsed}ms`);
  assert.ok(elapsed < 800, `wipe returned in ${elapsed}ms`);
  assert.deepEqual(await names(idb), []);
  assert.equal(await loadCachedDek({ userId, idb }), null);
});

test("signOut drops the in-memory key even when the device wipe stays blocked", { timeout: 2_000 }, async () => {
  const idb = new IDBFactory();
  const holder = new Vault();
  holder.set(await importDek(dek));
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  const other = await holdOpen(idb);
  try {
    await assert.rejects(
      () => signOut({ idb, vault: holder, blockedTimeoutMs: 80 }),
      (error: unknown) => error instanceof DeviceWipeBlockedError,
    );
    assert.equal(holder.isUnlocked(), false);
    assert.equal((await dump(other)).some((row) => row.id === "dek"), false);
  } finally {
    await settleDelete(other);
  }
  assert.equal(await loadCachedDek({ userId, idb }), null);
});

test("this tab closes its own connection on versionchange", async () => {
  const idb = new IDBFactory();
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  let saw = false;
  let usableAfter = true;
  const wrapped = new Proxy(idb, {
    get(target, prop, receiver) {
      if (prop === "open") {
        return (name: string, version?: number) => {
          const request = target.open(name, version);
          let handler: ((this: IDBRequest, ev: Event) => void) | null = null;
          Object.defineProperty(request, "onsuccess", {
            configurable: true,
            enumerable: true,
            get() {
              return handler;
            },
            set(fn: (this: IDBRequest, ev: Event) => void) {
              handler = function (ev) {
                fn.call(request, ev);
                const db = request.result;
                db.dispatchEvent(new IDBVersionChangeEvent("versionchange", {
                  oldVersion: db.version,
                  newVersion: null,
                }));
                try {
                  db.transaction("kv", "readonly");
                  usableAfter = true;
                } catch {
                  usableAfter = false;
                }
                saw = true;
              };
            },
          });
          return request;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as IDBFactory;
  await loadCachedDek({ userId, idb: wrapped }).catch(() => undefined);
  assert.equal(saw, true);
  assert.equal(usableAfter, false);
});
