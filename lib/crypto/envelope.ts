// AES-256-GCM record envelopes. AAD binds table, row id and owner.
// Wire form: {"v":1,"n":"<b64url 12B>","c":"<b64url ct||tag>"} — no whitespace, exact keys.

import {
  bytesToBase64Url,
  base64UrlToBytes,
  copyBytes,
  isBoundComponent,
  randomBytes,
  utf8Decode,
  utf8Encode,
  wipe,
} from "./bytes.ts";

/** Matches the per-record blob cap in the e2e server model (1.9M chars). */
export const MAX_ENVELOPE_CHARS = 1_900_000;

const ENVELOPE_RE = /^\{"v":1,"n":"([A-Za-z0-9_-]+)","c":"([A-Za-z0-9_-]+)"\}$/;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Authentication failed, or the AAD / key / nonce does not match. The message is generic on purpose. */
export class DecryptError extends Error {
  constructor(message = "decrypt failed") {
    super(message);
    this.name = "DecryptError";
  }
}

export type ByteRng = (length: number) => Uint8Array;

export type RecordContext = {
  table: string;
  id: string;
  userId: string;
};

function assertComponent(value: string, name: string): void {
  if (!isBoundComponent(value)) {
    throw new EnvelopeError(`invalid ${name}`);
  }
}

export function recordAad(ctx: RecordContext): Uint8Array {
  assertComponent(ctx.table, "table");
  assertComponent(ctx.id, "id");
  assertComponent(ctx.userId, "userId");
  return utf8Encode(`${ctx.table}|${ctx.id}|${ctx.userId}`);
}

/** AES-256-GCM. `ciphertext` and the result are ciphertext || 16-byte tag. */
export async function aesGcmSeal(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.byteLength !== 12) throw new EnvelopeError("nonce must be 12 bytes");
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: copyBytes(nonce), additionalData: copyBytes(aad), tagLength: 128 },
    key,
    copyBytes(plaintext),
  );
  return new Uint8Array(sealed);
}

export async function aesGcmOpen(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.byteLength !== 12) throw new EnvelopeError("nonce must be 12 bytes");
  if (ciphertextAndTag.byteLength < 16) throw new EnvelopeError("ciphertext is shorter than the tag");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copyBytes(nonce), additionalData: copyBytes(aad), tagLength: 128 },
      key,
      copyBytes(ciphertextAndTag),
    );
    return new Uint8Array(opened);
  } catch (err) {
    if (err instanceof EnvelopeError) throw err;
    throw new DecryptError("decrypt failed");
  }
}

function formatEnvelope(nonce: Uint8Array, ciphertextAndTag: Uint8Array): string {
  return `{"v":1,"n":"${bytesToBase64Url(nonce)}","c":"${bytesToBase64Url(ciphertextAndTag)}"}`;
}

export function parseEnvelope(envelope: string): { nonce: Uint8Array; ciphertextAndTag: Uint8Array } {
  if (typeof envelope !== "string") throw new EnvelopeError("envelope must be a string");
  if (envelope.length > MAX_ENVELOPE_CHARS) throw new EnvelopeError("envelope exceeds the size cap");
  const match = ENVELOPE_RE.exec(envelope);
  if (!match) throw new EnvelopeError("malformed envelope");
  let nonce: Uint8Array;
  let ciphertextAndTag: Uint8Array;
  try {
    nonce = base64UrlToBytes(match[1]);
    ciphertextAndTag = base64UrlToBytes(match[2]);
  } catch {
    throw new EnvelopeError("malformed envelope");
  }
  if (nonce.byteLength !== 12) throw new EnvelopeError("nonce must be 12 bytes");
  if (ciphertextAndTag.byteLength < 16) throw new EnvelopeError("ciphertext is shorter than the tag");
  return { nonce, ciphertextAndTag };
}

export async function sealBytes(
  dek: CryptoKey,
  ctx: RecordContext,
  plaintext: Uint8Array,
  rng: ByteRng = randomBytes,
): Promise<string> {
  const nonce = copyBytes(rng(12));
  if (nonce.byteLength !== 12) throw new EnvelopeError("nonce must be 12 bytes");
  const sealed = await aesGcmSeal(dek, nonce, plaintext, recordAad(ctx));
  const envelope = formatEnvelope(nonce, sealed);
  if (envelope.length > MAX_ENVELOPE_CHARS) throw new EnvelopeError("envelope exceeds the size cap");
  return envelope;
}

export async function openBytes(dek: CryptoKey, ctx: RecordContext, envelope: string): Promise<Uint8Array> {
  const parsed = parseEnvelope(envelope);
  return aesGcmOpen(dek, parsed.nonce, parsed.ciphertextAndTag, recordAad(ctx));
}

function canonicalValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EnvelopeError("plaintext has a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new EnvelopeError("plaintext must be JSON");
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] === undefined) {
        throw new EnvelopeError("plaintext arrays cannot contain holes");
      }
      items.push(canonicalValue(value[index]));
    }
    return items;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new EnvelopeError("plaintext must be plain JSON");
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    Object.defineProperty(sorted, key, {
      value: canonicalValue(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sorted;
}

/** RFC 8785-style key sort (UTF-16 code units) so two devices encrypt the same row bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sealRecord(
  dek: CryptoKey,
  ctx: RecordContext,
  plaintext: unknown,
  rng?: ByteRng,
): Promise<string> {
  const encoded = utf8Encode(canonicalJson(plaintext));
  try {
    return await sealBytes(dek, ctx, encoded, rng);
  } finally {
    wipe(encoded);
  }
}

export async function openRecord(dek: CryptoKey, ctx: RecordContext, envelope: string): Promise<unknown> {
  const raw = await openBytes(dek, ctx, envelope);
  try {
    const text = utf8Decode(raw);
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (err instanceof DecryptError || err instanceof EnvelopeError) throw err;
    throw new EnvelopeError("plaintext is not JSON");
  } finally {
    wipe(raw);
  }
}
