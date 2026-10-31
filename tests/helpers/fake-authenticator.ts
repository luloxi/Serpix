// Test double for a WebAuthn authenticator. PRF is HMAC-SHA-256(secret, "WebAuthn PRF\0" || salt).
// The same object is the same credential: a "new device" keeps this instance and gets a fresh IndexedDB.

import { bytesToBase64Url, concat, copyBytes, timingSafeEqual, utf8Encode } from "../../lib/crypto/bytes.ts";
import type { CredentialsLike } from "../../lib/crypto/passkey.ts";

export type FakeMode = "prf" | "prf-on-get" | "none";

type Stored = { rawId: Uint8Array<ArrayBuffer> };

function viewOf(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function readPrfSalt(options: CredentialCreationOptions | CredentialRequestOptions): Uint8Array | null {
  const extensions = options.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined;
  const first = extensions?.prf?.eval?.first;
  return first ? viewOf(first) : null;
}

async function hmacPrf(secret: Uint8Array, salt: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    copyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, concat(utf8Encode("WebAuthn PRF\0"), salt));
  return copyBytes(new Uint8Array(mac));
}

function authenticatorData(flags = 0x05): ArrayBuffer {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes.buffer;
}

function credential(rawId: Uint8Array<ArrayBuffer>, prf: { enabled?: boolean; results?: { first: ArrayBuffer } } | undefined) {
  const authData = authenticatorData();
  return {
    type: "public-key" as const,
    id: bytesToBase64Url(rawId),
    rawId: rawId.buffer,
    response: {
      clientDataJSON: utf8Encode("{}").buffer,
      authenticatorData: authData,
      getAuthenticatorData: () => authData,
    },
    getClientExtensionResults() {
      return prf ? { prf } : {};
    },
  };
}

export function fakeAuthenticator(secret: Uint8Array, mode: FakeMode = "prf"): CredentialsLike {
  const credentials = new Map<string, Stored>();

  return {
    async create(options) {
      const rawId = copyBytes(crypto.getRandomValues(new Uint8Array(16)));
      const id = bytesToBase64Url(rawId);
      credentials.set(id, { rawId });
      const salt = options.publicKey ? readPrfSalt(options) : null;
      if (mode === "none" || !salt) return credential(rawId, undefined);
      if (mode === "prf-on-get") return credential(rawId, { enabled: true });
      const output = await hmacPrf(secret, salt);
      return credential(rawId, { enabled: true, results: { first: output.buffer } });
    },
    async get(options) {
      const allowed = options.publicKey?.allowCredentials?.[0];
      if (!allowed) return null;
      const raw = viewOf(allowed.id);
      let stored: Stored | undefined;
      for (const entry of credentials.values()) {
        if (timingSafeEqual(entry.rawId, raw)) {
          stored = entry;
          break;
        }
      }
      if (!stored) return null;
      const salt = options.publicKey ? readPrfSalt(options) : null;
      if (mode === "none" || !salt) return credential(stored.rawId, undefined);
      const output = await hmacPrf(secret, salt);
      return credential(stored.rawId, { results: { first: output.buffer } });
    },
  };
}
