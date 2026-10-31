// DEK wraps. IKM -> HKDF-SHA-256(info = "serpix-e2e/v1/wrap/<type>") -> AES-256-GCM.
// AAD is `wrap|<type>|<userId>|<wrapId>`. The wrap key is not extractable.

import {
  base64UrlToBytes,
  bytesToBase64Url,
  copyBytes,
  isBoundComponent,
  randomBytes,
  utf8Encode,
  wipe,
} from "./bytes.ts";
import { aesGcmOpen, aesGcmSeal, DecryptError, type ByteRng } from "./envelope.ts";

const HKDF_INFO_PREFIX = "serpix-e2e/v1/wrap/";
const WRAP_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;

export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

export type PasswordParams = {
  /** Argon2id memory in KiB. */
  m: number;
  /** Argon2id iterations. */
  t: number;
  /** Argon2id parallelism. */
  p: number;
  /** base64url Argon2id salt. Password wraps we create use 16 bytes. */
  salt: string;
};

export type PasskeyParams = {
  /** base64url of the 32-byte PRF input salt. */
  prfSalt: string;
  /** base64url WebAuthn credential id. */
  credentialId: string;
};

export type Wrap = {
  v: 1;
  type: string;
  /** Bound into the AAD. Also stored so a recovery kit is enough, together with the password. */
  userId: string;
  wrapId: string;
  /** base64url HKDF salt, 32 bytes. */
  salt: string;
  /** base64url AES-GCM nonce, 12 bytes. */
  n: string;
  /** base64url ciphertext || 16-byte tag. The plaintext is the 32-byte DEK. */
  c: string;
  params?: PasswordParams | PasskeyParams;
};

function assertComponent(value: string, name: string): void {
  if (!isBoundComponent(value)) {
    throw new WrapError(`invalid ${name}`);
  }
}

function assertWrapType(type: string): void {
  if (!WRAP_TYPE.test(type)) throw new WrapError("invalid wrap type");
}

/**
 * HKDF-SHA-256 (RFC 5869). An empty salt is HashLen zero octets: some WebCrypto
 * builds reject a zero-length salt, so this passes 32 zero bytes in that case.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) {
    throw new Error("HKDF length out of range");
  }
  const saltBytes = salt.byteLength === 0 ? new Uint8Array(32) : salt;
  const base = await crypto.subtle.importKey("raw", copyBytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: copyBytes(saltBytes),
      info: copyBytes(info),
    },
    base,
    length * 8,
  );
  return copyBytes(new Uint8Array(bits));
}

export function wrapInfo(type: string): Uint8Array {
  assertWrapType(type);
  return utf8Encode(`${HKDF_INFO_PREFIX}${type}`);
}

export function wrapAad(type: string, userId: string, wrapId: string): Uint8Array {
  assertWrapType(type);
  assertComponent(userId, "userId");
  assertComponent(wrapId, "wrapId");
  return utf8Encode(`wrap|${type}|${userId}|${wrapId}`);
}

/** 256-bit AES-GCM key. `extractable` is false. */
export async function deriveWrapKey(ikm: Uint8Array, salt32: Uint8Array, type: string): Promise<CryptoKey> {
  if (salt32.byteLength !== 32) throw new WrapError("HKDF salt must be 32 bytes");
  const raw = await hkdfSha256(ikm, salt32, wrapInfo(type), 32);
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    wipe(raw);
  }
}

export type WrapDekOptions = {
  type: string;
  userId: string;
  wrapId: string;
  /** 32-byte HKDF salt. Default: the next 32 bytes from `rng`. */
  saltFn?: () => Uint8Array;
  /** Called as `rng(32)` for the salt (if `saltFn` is absent) and `rng(12)` for the nonce. */
  rng?: ByteRng;
  params?: PasswordParams | PasskeyParams;
};

export async function wrapDek(dekRaw: Uint8Array, ikm: Uint8Array, options: WrapDekOptions): Promise<Wrap> {
  if (dekRaw.byteLength !== 32) throw new WrapError("DEK must be 32 bytes");
  if (ikm.byteLength !== 32) throw new WrapError("wrap IKM must be 32 bytes");
  const rng = options.rng ?? randomBytes;
  const salt = copyBytes(options.saltFn ? options.saltFn() : rng(32));
  const nonce = copyBytes(rng(12));
  if (salt.byteLength !== 32) throw new WrapError("HKDF salt must be 32 bytes");
  if (nonce.byteLength !== 12) throw new WrapError("nonce must be 12 bytes");
  const key = await deriveWrapKey(ikm, salt, options.type);
  try {
    const sealed = await aesGcmSeal(key, nonce, dekRaw, wrapAad(options.type, options.userId, options.wrapId));
    const wrap: Wrap = {
      v: 1,
      type: options.type,
      userId: options.userId,
      wrapId: options.wrapId,
      salt: bytesToBase64Url(salt),
      n: bytesToBase64Url(nonce),
      c: bytesToBase64Url(sealed),
    };
    if (options.params) wrap.params = options.params;
    return wrap;
  } finally {
    wipe(salt);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function assertWrap(value: unknown): Wrap {
  if (!isRecord(value)) throw new WrapError("wrap must be an object");
  const allowed = value.params === undefined
    ? ["v", "type", "userId", "wrapId", "salt", "n", "c"]
    : ["v", "type", "userId", "wrapId", "salt", "n", "c", "params"];
  if (!exactKeys(value, allowed)) throw new WrapError("wrap keys are not exact");
  if (value.v !== 1) throw new WrapError("unsupported wrap version");
  if (typeof value.type !== "string" || !WRAP_TYPE.test(value.type)) throw new WrapError("invalid wrap type");
  assertComponent(value.userId as string, "userId");
  assertComponent(value.wrapId as string, "wrapId");
  for (const field of ["salt", "n", "c"] as const) {
    if (typeof value[field] !== "string") throw new WrapError(`invalid wrap ${field}`);
  }
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64UrlToBytes(value.salt as string);
    nonce = base64UrlToBytes(value.n as string);
    ciphertext = base64UrlToBytes(value.c as string);
  } catch {
    throw new WrapError("wrap fields are not base64url");
  }
  if (salt.byteLength !== 32) throw new WrapError("HKDF salt must be 32 bytes");
  if (nonce.byteLength !== 12) throw new WrapError("nonce must be 12 bytes");
  if (ciphertext.byteLength !== 48) throw new WrapError("wrapped DEK must be 32 bytes plus the tag");
  const wrap: Wrap = {
    v: 1,
    type: value.type,
    userId: value.userId as string,
    wrapId: value.wrapId as string,
    salt: value.salt as string,
    n: value.n as string,
    c: value.c as string,
  };
  if (value.params !== undefined) {
    wrap.params = assertParams(value.type, value.params);
  } else if (value.type === "password" || value.type === "passkey") {
    throw new WrapError("wrap is missing params");
  }
  return wrap;
}

function assertUint(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WrapError(`invalid ${name}`);
  }
  return value;
}

function assertParams(type: string, value: unknown): PasswordParams | PasskeyParams {
  if (!isRecord(value)) throw new WrapError("wrap params must be an object");
  if (type === "password") {
    if (!exactKeys(value, ["m", "t", "p", "salt"])) throw new WrapError("password params keys are not exact");
    const m = assertUint(value.m, "m", 8, 262_144);
    const t = assertUint(value.t, "t", 1, 10);
    const p = assertUint(value.p, "p", 1, 4);
    if (m < 8 * p) throw new WrapError("argon2 memory is below 8*p");
    if (typeof value.salt !== "string") throw new WrapError("invalid kdf salt");
    let salt: Uint8Array;
    try {
      salt = base64UrlToBytes(value.salt);
    } catch {
      throw new WrapError("invalid kdf salt");
    }
    if (salt.byteLength !== 16) throw new WrapError("argon2 salt must be 16 bytes");
    return { m, t, p, salt: value.salt };
  }
  if (type === "passkey") {
    if (!exactKeys(value, ["prfSalt", "credentialId"])) throw new WrapError("passkey params keys are not exact");
    for (const field of ["prfSalt", "credentialId"] as const) {
      if (typeof value[field] !== "string") throw new WrapError(`invalid ${field}`);
    }
    let prfSalt: Uint8Array;
    let credentialId: Uint8Array;
    try {
      prfSalt = base64UrlToBytes(value.prfSalt as string);
      credentialId = base64UrlToBytes(value.credentialId as string);
    } catch {
      throw new WrapError("passkey params are not base64url");
    }
    if (prfSalt.byteLength !== 32) throw new WrapError("PRF salt must be 32 bytes");
    if (credentialId.byteLength < 1 || credentialId.byteLength > 1024) throw new WrapError("invalid credential id");
    return { prfSalt: value.prfSalt as string, credentialId: value.credentialId as string };
  }
  throw new WrapError("unexpected params");
}

/** Recover the 32 raw DEK bytes. Caller imports them and wipes the returned buffer. */
export async function unwrapDek(wrap: Wrap, ikm: Uint8Array, ctx: { userId: string; wrapId: string }): Promise<Uint8Array> {
  const parsed = assertWrap(wrap);
  if (ikm.byteLength !== 32) throw new DecryptError("decrypt failed");
  if (parsed.userId !== ctx.userId || parsed.wrapId !== ctx.wrapId) throw new DecryptError("decrypt failed");
  const salt = base64UrlToBytes(parsed.salt);
  const nonce = base64UrlToBytes(parsed.n);
  const ciphertext = base64UrlToBytes(parsed.c);
  const key = await deriveWrapKey(ikm, salt, parsed.type);
  wipe(salt);
  const raw = await aesGcmOpen(key, nonce, ciphertext, wrapAad(parsed.type, ctx.userId, ctx.wrapId));
  if (raw.byteLength !== 32) {
    wipe(raw);
    throw new DecryptError("decrypt failed");
  }
  return raw;
}

/** Stable JSON for kits and storage. Key order is fixed. */
export function serializeWrap(wrap: Wrap): string {
  const parsed = assertWrap(wrap);
  const base: Record<string, unknown> = {
    v: parsed.v,
    type: parsed.type,
    userId: parsed.userId,
    wrapId: parsed.wrapId,
    salt: parsed.salt,
    n: parsed.n,
    c: parsed.c,
  };
  if (parsed.params && parsed.type === "password") {
    const params = parsed.params as PasswordParams;
    base.params = { m: params.m, t: params.t, p: params.p, salt: params.salt };
  } else if (parsed.params && parsed.type === "passkey") {
    const params = parsed.params as PasskeyParams;
    base.params = { prfSalt: params.prfSalt, credentialId: params.credentialId };
  }
  return JSON.stringify(base);
}
