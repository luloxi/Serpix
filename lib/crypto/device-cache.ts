// Optional "recordar en este dispositivo". Default off: nothing is written unless
// `remember` is true. The device key is a non-extractable AES-GCM CryptoKey kept in
// IndexedDB (structured clone). It wraps the raw DEK. Sign-out deletes the database.
// A delete that stays blocked is a failure: the stored key is removed first so the
// next login cannot auto-unlock from this device. Never localStorage.

import { base64UrlToBytes, bytesToBase64Url, randomBytes, utf8Encode } from "./bytes.ts";
import { aesGcmOpen, aesGcmSeal, DecryptError, EnvelopeError } from "./envelope.ts";

export const DEVICE_DB_NAME = "serpix-e2e-device";
export const DEVICE_STORE = "kv";
/** How long a sign-out waits for other tabs to release the device database. */
export const DEVICE_WIPE_BLOCKED_MS = 3000;

const DEVICE_KEY_ID = "device-key";
const DEK_ID = "dek";

/** `deleteDatabase` stayed blocked until the timeout. The session can still end. */
export class DeviceWipeBlockedError extends Error {
  constructor() {
    super("device wipe blocked");
    this.name = "DeviceWipeBlockedError";
  }
}

const connections = new Map<IDBFactory, Set<IDBDatabase>>();

function watch(idb: IDBFactory, db: IDBDatabase): void {
  let open = connections.get(idb);
  if (!open) {
    open = new Set();
    connections.set(idb, open);
  }
  open.add(db);
  db.onversionchange = () => {
    release(idb, db);
  };
}

function release(idb: IDBFactory, db: IDBDatabase): void {
  const open = connections.get(idb);
  if (open) {
    open.delete(db);
    if (open.size === 0) connections.delete(idb);
  }
  db.close();
}

function closeOwnConnections(idb: IDBFactory): void {
  const open = connections.get(idb);
  if (!open) return;
  for (const db of [...open]) release(idb, db);
}

type DeviceKeyRow = { id: typeof DEVICE_KEY_ID; key: CryptoKey };
type DekRow = { id: typeof DEK_ID; userId: string; n: string; c: string };

function idbFactory(idb?: IDBFactory): IDBFactory {
  const resolved = idb ?? globalThis.indexedDB;
  if (!resolved) throw new Error("IndexedDB is not available");
  return resolved;
}

async function knownDatabases(idb: IDBFactory): Promise<string[] | null> {
  const factory = idb as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof factory.databases !== "function") return null;
  const rows = await factory.databases();
  return rows.map((row) => row.name ?? "").filter((name) => name.length > 0);
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DEVICE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      watch(idb, db);
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function finish(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.length < 1 || userId.length > 256 || userId.includes("|")) {
    throw new EnvelopeError("invalid userId");
  }
}

/**
 * Wrap `dekRaw` under a fresh device key and store both in IndexedDB.
 * `remember !== true` returns without opening the database.
 */
export async function cacheDek(options: {
  dekRaw: Uint8Array;
  userId: string;
  remember: boolean;
  idb?: IDBFactory;
}): Promise<void> {
  if (options.remember !== true) return;
  assertUserId(options.userId);
  if (options.dekRaw.byteLength !== 32) throw new Error("DEK must be 32 bytes");
  const idb = idbFactory(options.idb);
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const nonce = randomBytes(12);
  const sealed = await aesGcmSeal(deviceKey, nonce, options.dekRaw, utf8Encode(`device|${options.userId}`));
  const db = await openDb(idb);
  try {
    const tx = db.transaction(DEVICE_STORE, "readwrite");
    const store = tx.objectStore(DEVICE_STORE);
    store.put({ id: DEVICE_KEY_ID, key: deviceKey } satisfies DeviceKeyRow);
    store.put({
      id: DEK_ID,
      userId: options.userId,
      n: bytesToBase64Url(nonce),
      c: bytesToBase64Url(sealed),
    } satisfies DekRow);
    await finish(tx);
  } finally {
    release(idb, db);
  }
}

/** Raw DEK bytes, or null when this device has no cache for `userId`. Caller wipes the buffer. */
export async function loadCachedDek(options: { userId: string; idb?: IDBFactory }): Promise<Uint8Array | null> {
  assertUserId(options.userId);
  const idb = options.idb ?? globalThis.indexedDB;
  if (!idb) return null;
  const names = await knownDatabases(idb);
  if (names && !names.includes(DEVICE_DB_NAME)) return null;
  const db = await openDb(idb);
  try {
    const tx = db.transaction(DEVICE_STORE, "readonly");
    const store = tx.objectStore(DEVICE_STORE);
    const keyRequest = store.get(DEVICE_KEY_ID);
    const dekRequest = store.get(DEK_ID);
    const [keyRow, dekRow] = await new Promise<[DeviceKeyRow | undefined, DekRow | undefined]>((resolve, reject) => {
      tx.oncomplete = () => resolve([keyRequest.result as DeviceKeyRow | undefined, dekRequest.result as DekRow | undefined]);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    });
    if (!keyRow?.key || !dekRow) return null;
    if (dekRow.userId !== options.userId) return null;
    const deviceKey = keyRow.key;
    if (!(deviceKey instanceof CryptoKey) || deviceKey.extractable) throw new DecryptError("decrypt failed");
    let nonce: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      nonce = base64UrlToBytes(dekRow.n);
      ciphertext = base64UrlToBytes(dekRow.c);
    } catch {
      throw new DecryptError("decrypt failed");
    }
    return await aesGcmOpen(deviceKey, nonce, ciphertext, utf8Encode(`device|${options.userId}`));
  } finally {
    release(idb, db);
  }
}

/**
 * Drop the wrapped key in its own transaction before `deleteDatabase`.
 * A normal open connection does not block this write. Skip when the database
 * is absent: opening would create it. `databases()` missing means we cannot
 * tell, so we do not create one either.
 */
async function dropStoredRecords(idb: IDBFactory): Promise<void> {
  const names = await knownDatabases(idb);
  if (!names?.includes(DEVICE_DB_NAME)) return;
  const db = await openDb(idb);
  try {
    if (!db.objectStoreNames.contains(DEVICE_STORE)) return;
    const tx = db.transaction(DEVICE_STORE, "readwrite");
    tx.objectStore(DEVICE_STORE).clear();
    await finish(tx);
  } finally {
    release(idb, db);
  }
}

function deleteDeviceDatabase(idb: IDBFactory, blockedTimeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (follow: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      follow();
    };
    const request = idb.deleteDatabase(DEVICE_DB_NAME);
    request.onsuccess = () => stop(() => resolve());
    request.onerror = () => stop(() => reject(request.error ?? new Error("IndexedDB delete failed")));
    // Stay pending. The delete finishes when the other tabs close; until then this is not success.
    request.onblocked = () => {
      if (settled || timer !== undefined) return;
      timer = setTimeout(() => {
        stop(() => reject(new DeviceWipeBlockedError()));
      }, blockedTimeoutMs);
    };
  });
}

/** Delete the device database. Sign-out calls this. Missing databases are not an error. */
export async function clearDeviceCache(options?: { idb?: IDBFactory; blockedTimeoutMs?: number }): Promise<void> {
  const idb = options?.idb ?? globalThis.indexedDB;
  if (!idb) return;
  const blockedTimeoutMs = options?.blockedTimeoutMs ?? DEVICE_WIPE_BLOCKED_MS;
  closeOwnConnections(idb);
  try {
    await dropStoredRecords(idb);
  } catch {
    // The database may still be deletable. A blocked delete rejects below.
  }
  closeOwnConnections(idb);
  await deleteDeviceDatabase(idb, blockedTimeoutMs);
}
