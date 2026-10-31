// Byte helpers for the client vault. No server imports. Runs in browsers and in node:test.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Unpadded base64url alphabet (RFC 4648 §5). */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function fresh(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = fresh(length);
  crypto.getRandomValues(out);
  return out;
}

/** Copy into a fresh ArrayBuffer so WebCrypto accepts the view and the caller can wipe the original. */
export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = fresh(bytes.byteLength);
  out.set(bytes);
  return out;
}

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return copyBytes(textEncoder.encode(value));
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = fresh(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Best-effort constant-time compare. Length still leaks: callers that need
 * a fixed size (tags, keys) pass equal lengths. Not a substitute for GCM.
 */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** AAD components: non-empty, no `|`, no ASCII controls, at most 256 chars. */
export function isBoundComponent(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.includes("|")) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/** Overwrite secret bytes. Best effort: copies the runtime already made are out of reach. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
