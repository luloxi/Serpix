// WebAuthn passkey + the PRF extension. The PRF output is the wrap IKM.
// If the authenticator never returns PRF bytes, registration throws PrfUnsupportedError
// and the caller keeps the password wrap only. User verification is required. A 32-byte
// all-zero PRF, or a get() whose rawId is not the credential we asked for, is the same failure.

import { bytesToBase64Url, copyBytes, randomBytes, timingSafeEqual, utf8Encode, wipe } from "./bytes.ts";
import { DecryptError, type ByteRng } from "./envelope.ts";
import { unwrapDek, wrapDek, WrapError, type Wrap } from "./wrap.ts";

export class PrfUnsupportedError extends Error {
  constructor(message = "this authenticator did not return a PRF result") {
    super(message);
    this.name = "PrfUnsupportedError";
  }
}

/** authenticatorData flags did not show user presence and user verification. */
export class UserVerificationError extends Error {
  constructor(message = "the authenticator did not verify the user") {
    super(message);
    this.name = "UserVerificationError";
  }
}

const UV_FLAG = 0x04;
const UP_FLAG = 0x01;

/** Reject a short authenticatorData or one whose UV or UP bit is off. */
export function assertUserVerified(authData: Uint8Array): void {
  if (authData.byteLength < 37) throw new UserVerificationError("authenticatorData is too short");
  const flags = authData[32];
  if ((flags & UP_FLAG) === 0 || (flags & UV_FLAG) === 0) throw new UserVerificationError();
}

function readCborInfo(bytes: Uint8Array, offset: number): { major: number; value: number; offset: number } {
  if (offset >= bytes.length) throw new UserVerificationError("short attestation");
  const head = bytes[offset];
  offset += 1;
  const major = head >> 5;
  const info = head & 31;
  let value = info;
  if (info < 24) return { major, value, offset };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (width === 0) throw new UserVerificationError("unsupported CBOR length");
  if (offset + width > bytes.length) throw new UserVerificationError("short attestation");
  value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + bytes[offset + i];
  return { major, value, offset: offset + width };
}

function skipCbor(bytes: Uint8Array, offset: number): number {
  const item = readCborInfo(bytes, offset);
  offset = item.offset;
  if (item.major === 0 || item.major === 1 || item.major === 7) return offset;
  if (item.major === 2 || item.major === 3) {
    if (offset + item.value > bytes.length) throw new UserVerificationError("short attestation");
    return offset + item.value;
  }
  if (item.major === 4) {
    for (let i = 0; i < item.value; i++) offset = skipCbor(bytes, offset);
    return offset;
  }
  if (item.major === 5) {
    for (let i = 0; i < item.value; i++) {
      offset = skipCbor(bytes, offset);
      offset = skipCbor(bytes, offset);
    }
    return offset;
  }
  if (item.major === 6) return skipCbor(bytes, offset);
  throw new UserVerificationError("unsupported CBOR");
}

/** authData from a WebAuthn attestationObject (a CBOR map). */
export function authDataFromAttestation(bytes: Uint8Array): Uint8Array {
  const map = readCborInfo(bytes, 0);
  if (map.major !== 5) throw new UserVerificationError("attestation is not a map");
  let offset = map.offset;
  for (let i = 0; i < map.value; i++) {
    const key = readCborInfo(bytes, offset);
    if (key.major === 3) {
      offset = key.offset;
      if (offset + key.value > bytes.length) throw new UserVerificationError("short attestation");
      const name = new TextDecoder().decode(bytes.subarray(offset, offset + key.value));
      offset += key.value;
      if (name === "authData") {
        const value = readCborInfo(bytes, offset);
        if (value.major !== 2) throw new UserVerificationError("authData is not bytes");
        offset = value.offset;
        if (offset + value.value > bytes.length) throw new UserVerificationError("short attestation");
        return bytes.slice(offset, offset + value.value);
      }
      offset = skipCbor(bytes, offset);
    } else {
      offset = skipCbor(bytes, offset);
      offset = skipCbor(bytes, offset);
    }
  }
  throw new UserVerificationError("attestation has no authData");
}

function bufferOf(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function requireVerified(credential: unknown, kind: "create" | "get"): void {
  const response = (credential as { response?: { authenticatorData?: unknown; attestationObject?: unknown; getAuthenticatorData?: () => ArrayBuffer } }).response;
  if (!response) throw new UserVerificationError();
  if (kind === "get") {
    const authData = bufferOf(response.authenticatorData);
    if (!authData) throw new UserVerificationError();
    assertUserVerified(authData);
    return;
  }
  if (typeof response.getAuthenticatorData === "function") {
    const produced = response.getAuthenticatorData();
    const authData = bufferOf(produced);
    if (!authData) throw new UserVerificationError();
    assertUserVerified(authData);
    return;
  }
  const attestation = bufferOf(response.attestationObject);
  if (!attestation) throw new UserVerificationError();
  assertUserVerified(authDataFromAttestation(attestation));
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
  firstSource: BufferSource | null;
  rawId: Uint8Array<ArrayBuffer> | null;
};

function bytesOf(value: BufferSource): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return copyBytes(new Uint8Array(value));
  return copyBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function readPrf(credential: unknown): PrfResult {
  if (!credential || typeof credential !== "object") {
    return { enabled: false, first: null, firstSource: null, rawId: null };
  }
  const record = credential as {
    rawId?: BufferSource;
    getClientExtensionResults?: () => { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
  };
  const rawId = record.rawId ? bytesOf(record.rawId) : null;
  const prf = record.getClientExtensionResults?.().prf;
  const firstSource = prf?.results?.first ?? null;
  const first = firstSource ? bytesOf(firstSource) : null;
  return { enabled: prf?.enabled === true || first !== null, first, firstSource, rawId };
}

/** 32 zero bytes are not a PRF key. The scan does not stop on the first non-zero byte. */
function isAllZeroPrf(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 32) return false;
  let diff = 0;
  for (let i = 0; i < bytes.byteLength; i++) diff |= bytes[i];
  return diff === 0;
}

function wipeBufferSource(value: BufferSource | null): void {
  if (!value) return;
  if (ArrayBuffer.isView(value)) {
    wipe(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  wipe(new Uint8Array(value));
}

function wipeHeldPrf(result: PrfResult): void {
  if (result.first) wipe(result.first);
  if (result.rawId) wipe(result.rawId);
  wipeBufferSource(result.firstSource);
}

/**
 * 32-byte non-zero PRF. When `expectedId` is set, `rawId` must be the same bytes.
 * Returns null when the caller must wipe and reject. Does not modify `expectedId`.
 */
function acceptedPrf(result: PrfResult, expectedId: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  const output = result.first;
  const returnedId = result.rawId;
  const zeroPrf = output !== null && isAllZeroPrf(output);
  const sameCredential = expectedId === null || (returnedId !== null && timingSafeEqual(returnedId, expectedId));
  if (output === null || output.byteLength !== 32 || zeroPrf || !sameCredential) return null;
  if (returnedId && expectedId !== null) wipe(returnedId);
  return output;
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
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
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
  try { requireVerified(created, "create"); } catch (err) {
    wipe(prfSalt);
    throw err;
  }
  const fromCreate = readPrf(created);
  if (!fromCreate.rawId) {
    wipe(prfSalt);
    wipeHeldPrf(fromCreate);
    throw new PrfUnsupportedError("the authenticator did not return a credential id");
  }
  if (fromCreate.first && fromCreate.first.byteLength === 32) {
    const output = acceptedPrf(fromCreate, null);
    if (!output) {
      wipeHeldPrf(fromCreate);
      wipe(prfSalt);
      throw new PrfUnsupportedError();
    }
    return { credentialId: fromCreate.rawId, prfSalt, prfOutput: output };
  }
  wipe(fromCreate.first ?? new Uint8Array());
  wipeBufferSource(fromCreate.firstSource);
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
        userVerification: "required",
        extensions: prfExtension(prfSalt),
      },
    });
  } catch (err) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw err;
  }
  if (!asserted) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw new PrfUnsupportedError("the passkey ceremony was cancelled");
  }
  try { requireVerified(asserted, "get"); } catch (err) {
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw err;
  }
  const fromGet = readPrf(asserted);
  const output = acceptedPrf(fromGet, fromCreate.rawId);
  if (!output) {
    wipeHeldPrf(fromGet);
    wipe(prfSalt);
    wipe(fromCreate.rawId);
    throw new PrfUnsupportedError();
  }
  return { credentialId: fromCreate.rawId, prfSalt, prfOutput: output };
}

export async function getPrfOutput(options: GetPrfOptions): Promise<Uint8Array> {
  if (options.prfSalt.byteLength !== 32) throw new PrfUnsupportedError("PRF salt must be 32 bytes");
  const asserted = await options.credentials.get({
    publicKey: {
      challenge: copyBytes(options.challenge),
      rpId: options.rpId,
      allowCredentials: [{ type: "public-key", id: copyBytes(options.credentialId) }],
      userVerification: "required",
      extensions: prfExtension(options.prfSalt),
    },
  });
  if (!asserted) throw new PrfUnsupportedError("the passkey ceremony was cancelled");
  requireVerified(asserted, "get");
  const prf = readPrf(asserted);
  const output = acceptedPrf(prf, options.credentialId);
  if (!output) {
    wipeHeldPrf(prf);
    throw new PrfUnsupportedError();
  }
  return output;
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
