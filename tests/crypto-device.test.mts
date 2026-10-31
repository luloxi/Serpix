// Device cache. Default off. IndexedDB holds a non-extractable key and a wrapped DEK, never the raw DEK.

import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { bytesToBase64Url } from "../lib/crypto/bytes.ts";
import { importDek, Vault } from "../lib/crypto/dek.ts";
import { DEVICE_DB_NAME, cacheDek, clearDeviceCache, loadCachedDek } from "../lib/crypto/device-cache.ts";
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

  await clearDeviceCache({ idb });
  assert.deepEqual(await names(idb), []);
  assert.equal(await loadCachedDek({ userId, idb }), null);
});

test("signOut clears the vault and the device database", async () => {
  const idb = new IDBFactory();
  const holder = new Vault();
  holder.set(await importDek(dek));
  await cacheDek({ dekRaw: dek, userId, remember: true, idb });
  vault.clear();
  await signOut({ idb, vault: holder });
  assert.equal(holder.isUnlocked(), false);
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(await names(idb), []);
  await signOut({ idb });
  assert.equal(vault.isUnlocked(), false);
});
