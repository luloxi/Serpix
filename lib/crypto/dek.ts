// The data-encryption key. Raw bytes exist only while wrapping or importing.
// At runtime the DEK is a non-extractable AES-GCM CryptoKey in `vault`.

import { copyBytes, randomBytes, wipe } from "./bytes.ts";

export class VaultLockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "VaultLockedError";
  }
}

export function generateDekBytes(): Uint8Array {
  return randomBytes(32);
}

/**
 * Import 32 raw bytes as AES-256-GCM. `extractable` is false, so `exportKey` rejects.
 * The input buffer is not wiped here: the caller wipes it after this promise resolves.
 */
export async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error("DEK must be 32 bytes");
  const copy = copyBytes(raw);
  try {
    return await crypto.subtle.importKey(
      "raw",
      copy,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    wipe(copy);
  }
}

/** In-memory holder. The key is never serialised. `pagehide` does not clear it; sign-out does. */
export class Vault {
  #key: CryptoKey | null = null;

  set(key: CryptoKey): void {
    if (key.type !== "secret" || !key.algorithm || (key.algorithm as AesKeyAlgorithm).name !== "AES-GCM") {
      throw new Error("vault only holds an AES-GCM key");
    }
    if (key.extractable) throw new Error("vault refuses an extractable key");
    if (!key.usages.includes("encrypt") || !key.usages.includes("decrypt")) {
      throw new Error("vault key must encrypt and decrypt");
    }
    this.#key = key;
  }

  get(): CryptoKey {
    if (!this.#key) throw new VaultLockedError();
    return this.#key;
  }

  clear(): void {
    this.#key = null;
  }

  isUnlocked(): boolean {
    return this.#key !== null;
  }
}

/** Process-wide vault. Sign-out calls `clear`. */
export const vault = new Vault();
