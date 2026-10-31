// WebAuthn passkey + the PRF extension. The PRF output is the wrap IKM.
// If the authenticator never returns PRF bytes, registration throws PrfUnsupportedError
// and the caller keeps the password wrap only.

import { bytesToBase64Url, copyBytes, randomBytes, utf8Encode, wipe } from "./bytes.ts";
import { DecryptError, type ByteRng } from "./envelope.ts";
import { unwrapDek, wrapDek, WrapError, type Wrap } from "./wrap.ts";

export class PrfUnsupportedError extends Error {
  constructor(message = "this authenticator did not return a PRF result") {
    super(message);
    this.name = "PrfUnsupportedError";
  }
}

export type RegisteredPasskey = {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  prfOutput: Uint8Array;
};

/** Structural stand-in for `navigator.credentials`, so tests can inject a fake. */
export interface CredentialsLike {
  create(options: CredentialCreationOptions): Promise<unknown>;
  get(options: CredentialRequestOptions): Promise<unknown>;
}

export type RegisterPasskeyOptions = {
  userId: string;
  userName: string;
  rpId: string;
  challenge: Uint8Array;
  credentials: CredentialsLike;
  rpName?: string;
  rng?: ByteRng;
};

export type GetPrfOptions = {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  rpId: string;
  challenge: Uint8Array;
  credentials: CredentialsLike;
};

type PrfResult = {
  enabled: boolean;
  first: Uint8Array<ArrayBuffer> | null;
  rawId: Uint8Array<ArrayBuffer> | null;
};

function bytesOf(value: BufferSource): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return copyBytes(new Uint8Array(value));
  return copyBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function readPrf(credential: unknown): PrfResult {
  if (!credential || typeof credential !== "object") return { enabled: false, first: null, rawId: null };
  const record = credential as {
    rawId?: BufferSource;
    getClientExtensionResults?: () => { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
  };
  const rawId = record.rawId ? bytesOf(record.rawId) : null;
  const prf = record.getClientExtensionResults?.().prf;
  const firstSource = prf?.results?.first;
  const first = firstSource ? bytesOf(firstSource) : null;
  return { enabled: prf?.enabled === true || first !== null, first, rawId };
}

function prfExtension(prfSalt: Uint8Array): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: copyBytes(prfSalt) } } };
}

export async function registerPasskey(options: RegisterPasskeyOptions): Promise<RegisteredPasskey> {
  const userIdBytes = utf8Encode(options.userId);
  if (userIdBytes.byteLength < 1 || userIdBytes.byteLength > 64) {
    throw new Error("userId must be 1 to 64 bytes as UTF-8");
  }
  const rng = options.rng ?? randomBytes;
  const prfSalt = copyBytes(rng(32));
  if (prfSalt.byteLength !== 32) {
    wipe(prfSalt);
    throw new Error("PRF salt must be 32 bytes");
  }
  let created: unknown;
  try {
    created = await options.credentials.create({
      publicKey: {
        rp: { id: options.rpId, name: options.rpName ?? "Serpix" },
        user: { id: userIdBytes, name: options.userName, displayName: options.userName },
        challenge: copyBytes(options.challenge),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -7 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        attestation: "none",
        extensions: prfExtension(prfSalt),
      },
    });
  } catch (err) {
    wipe(prfSalt);
    throw err;
  }
  if (!created) {
    wipe(prfSalt);
    throw new PrfUnsupportedError("the passkey ceremony was cancelled");
  }
  const fromCreate = readPrf(created);
  if (!fromCreate.rawId) {
    wipe(prfSalt);
    throw new PrfUnsupportedError("the authenticator did not return a credential id");
  }
  if (fromCreate.first && fromCreate.first.byteLength === 32) {
    return { credentialId: fromCreate.rawId, prfSalt, prfOutput: fromCreate.first };
  }
  wipe(fromCreate.first ?? new Uint8Array());
  // `create()` often reports prf.enabled and withholds the secret until a later get().
  if (!fromCreate.enabled) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw new PrfUnsupportedError();
  }
  let asserted: unknown;
  try {
    asserted = await options.credentials.get({
      publicKey: {
        challenge: copyBytes(options.challenge),
        rpId: options.rpId,
        allowCredentials: [{ type: "public-key", id: fromCreate.rawId }],
        userVerification: "preferred",
        extensions: prfExtension(prfSalt),
      },
    });
  } catch (err) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw err;
  }
  const fromGet = readPrf(asserted);
  if (!fromGet.first || fromGet.first.byteLength !== 32) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    if (fromGet.first) wipe(fromGet.first);
    throw new PrfUnsupportedError();
  }
  return { credentialId: fromCreate.rawId, prfSalt, prfOutput: fromGet.first };
}

export async function getPrfOutput(options: GetPrfOptions): Promise<Uint8Array> {
  if (options.prfSalt.byteLength !== 32) throw new PrfUnsupportedError("PRF salt must be 32 bytes");
  const asserted = await options.credentials.get({
    publicKey: {
      challenge: copyBytes(options.challenge),
      rpId: options.rpId,
      allowCredentials: [{ type: "public-key", id: copyBytes(options.credentialId) }],
      userVerification: "preferred",
      extensions: prfExtension(options.prfSalt),
    },
  });
  const prf = readPrf(asserted);
  if (!prf.first || prf.first.byteLength !== 32) {
    if (prf.first) wipe(prf.first);
    throw new PrfUnsupportedError();
  }
  return prf.first;
}

export async function createPasskeyWrap(
  dekRaw: Uint8Array,
  prfOutput: Uint8Array,
  options: {
    userId: string;
    wrapId: string;
    credentialId: Uint8Array;
    prfSalt: Uint8Array;
    rng?: ByteRng;
  },
): Promise<Wrap> {
  if (prfOutput.byteLength !== 32 || options.prfSalt.byteLength !== 32) {
    throw new PrfUnsupportedError("PRF salt and output must be 32 bytes");
  }
  return wrapDek(dekRaw, prfOutput, {
    type: "passkey",
    userId: options.userId,
    wrapId: options.wrapId,
    rng: options.rng,
    params: {
      prfSalt: bytesToBase64Url(options.prfSalt),
      credentialId: bytesToBase64Url(options.credentialId),
    },
  });
}

export async function openPasskeyWrap(
  wrap: Wrap,
  prfOutput: Uint8Array,
  ctx: { userId: string; wrapId: string },
): Promise<Uint8Array> {
  if (wrap.type !== "passkey") throw new WrapError("not a passkey wrap");
  if (prfOutput.byteLength !== 32) throw new DecryptError("decrypt failed");
  return unwrapDek(wrap, prfOutput, ctx);
}
