// AES-256-GCM for one Luma ICS link. The key is the LUMA_SETTINGS_KEY secret (64 hex chars).
// Output is base64. AAD is the user id. Nothing here is logged.

export const LUMA_KEY_ERROR = "LUMA_SETTINGS_KEY no configurada";

function fresh(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const out = fresh(encoded.byteLength);
  out.set(encoded);
  return out;
}

function parseKey(raw: string | undefined | null): Uint8Array<ArrayBuffer> | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = fresh(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = fresh(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(raw: string | undefined | null, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const bytes = parseKey(raw);
  if (!bytes) throw new Error(LUMA_KEY_ERROR);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}

export async function encryptLumaUrl(url: string, userId: string, keyHex: string | undefined | null): Promise<{ cipher: string; iv: string }> {
  const key = await importKey(keyHex, "encrypt");
  const iv = fresh(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(userId) },
    key,
    new TextEncoder().encode(url),
  );
  return { cipher: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

export async function decryptLumaUrl(cipher: string, iv: string, userId: string, keyHex: string | undefined | null): Promise<string> {
  const key = await importKey(keyHex, "decrypt");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: utf8(userId) },
    key,
    base64ToBytes(cipher),
  );
  return new TextDecoder().decode(plain);
}
