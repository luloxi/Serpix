// Record envelopes: round trip, AAD, tamper, validation, nonce uniqueness, non-extractable DEK.

import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64Url, utf8Encode, wipe } from "../lib/crypto/bytes.ts";
import { generateDekBytes, importDek, Vault, VaultLockedError, vault } from "../lib/crypto/dek.ts";
import {
  DecryptError,
  EnvelopeError,
  MAX_ENVELOPE_CHARS,
  canonicalJson,
  openBytes,
  openRecord,
  parseEnvelope,
  sealBytes,
  sealRecord,
} from "../lib/crypto/envelope.ts";
import { bytesToHex, containsBytes, hexToBytes } from "./helpers/codec.ts";

const ctx = { table: "contacts", id: "row-1", userId: "user-1" };

async function dek(): Promise<CryptoKey> {
  return importDek(generateDekBytes());
}

test("canonical JSON sorts keys, skips undefined, and rejects non-JSON", () => {
  assert.equal(canonicalJson({ note: "Ñandú", name: "Ada" }), '{"name":"Ada","note":"Ñandú"}');
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: true } }), '{"a":{"a":true,"b":2},"z":1}');
  assert.equal(canonicalJson({ a: -0, b: undefined, c: null }), '{"a":0,"c":null}');
  const proto = JSON.parse('{"__proto__":{"x":1},"b":2}');
  assert.equal(canonicalJson(proto), '{"__proto__":{"x":1},"b":2}');
  assert.throws(() => canonicalJson({ a: Number.NaN }), EnvelopeError);
  assert.throws(() => canonicalJson({ a: Infinity }), EnvelopeError);
  assert.throws(() => canonicalJson(undefined), EnvelopeError);
  assert.throws(() => canonicalJson(1n), EnvelopeError);
  assert.throws(() => canonicalJson(new Date("2026-10-31T00:00:00.000Z")), EnvelopeError);
  const sparse = [1, 2, 3];
  delete sparse[1];
  assert.throws(() => canonicalJson(sparse), EnvelopeError);
  assert.throws(() => canonicalJson([1, undefined, 3]), EnvelopeError);
  const hole: unknown[] = [];
  hole.length = 1;
  assert.throws(() => canonicalJson(hole), EnvelopeError);
});

test("sealRecord and sealBytes round-trip, and two objects with the same fields match", async () => {
  const key = await dek();
  const record = { note: "Ñandú", name: "Ada", n: 0, ok: true, tags: ["a", "b"] };
  const envelope = await sealRecord(key, ctx, record);
  assert.deepEqual(await openRecord(key, ctx, envelope), {
    name: "Ada",
    n: 0,
    note: "Ñandú",
    ok: true,
    tags: ["a", "b"],
  });
  const fixed = () => hexToBytes("c0c1c2c3c4c5c6c7c8c9cacb");
  const left = await sealRecord(key, ctx, { b: 1, a: 2 }, fixed);
  const right = await sealRecord(key, ctx, { a: 2, b: 1 }, fixed);
  assert.equal(left, right);

  const empty = await sealBytes(key, ctx, new Uint8Array());
  assert.equal((await openBytes(key, ctx, empty)).byteLength, 0);
  const binary = Uint8Array.of(0, 255, 10, 13);
  assert.deepEqual(await openBytes(key, ctx, await sealBytes(key, ctx, binary)), binary);
});

test("plaintext does not appear in the envelope string or the ciphertext bytes", async () => {
  const key = await dek();
  const plaintext = { secret: "Ñandú-UNIQUE-phrase", name: "Ada Lovelace" };
  const encoded = utf8Encode(canonicalJson(plaintext));
  const envelope = await sealRecord(key, ctx, plaintext);
  assert.equal(envelope.includes("Ñandú"), false);
  assert.equal(envelope.includes("Ada"), false);
  assert.equal(envelope.includes("UNIQUE"), false);
  assert.equal(envelope.includes(bytesToBase64Url(encoded)), false);
  const parsed = parseEnvelope(envelope);
  assert.equal(containsBytes(parsed.ciphertextAndTag, encoded), false);
  assert.equal(containsBytes(parsed.ciphertextAndTag, utf8Encode("Ñandú-UNIQUE-phrase")), false);
  assert.equal(containsBytes(parsed.ciphertextAndTag, utf8Encode("Ada Lovelace")), false);
  wipe(encoded);
});

test("each seal uses a fresh nonce", async () => {
  const key = await dek();
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const envelope = await sealBytes(key, ctx, Uint8Array.of(i & 0xff));
    const nonce = parseEnvelope(envelope).nonce;
    const id = bytesToHex(nonce);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
});

test("opening with a different table, id, user or DEK fails", async () => {
  const key = await dek();
  const envelope = await sealRecord(key, ctx, { name: "Ada" });
  await assert.rejects(() => openRecord(key, { ...ctx, table: "notes" }, envelope), DecryptError);
  await assert.rejects(() => openRecord(key, { ...ctx, id: "row-2" }, envelope), DecryptError);
  await assert.rejects(() => openRecord(key, { ...ctx, userId: "user-2" }, envelope), DecryptError);
  await assert.rejects(async () => openRecord(await dek(), ctx, envelope), DecryptError);
});

test("flipping any nonce, ciphertext or tag byte fails", async () => {
  const key = await dek();
  const envelope = await sealRecord(key, ctx, { name: "Ada" });
  const parsed = parseEnvelope(envelope);
  const flip = async (nonce: Uint8Array, body: Uint8Array) => {
    const tampered = `{"v":1,"n":"${bytesToBase64Url(nonce)}","c":"${bytesToBase64Url(body)}"}`;
    await assert.rejects(() => openRecord(key, ctx, tampered), DecryptError);
  };
  for (let i = 0; i < parsed.nonce.byteLength; i++) {
    const nonce = new Uint8Array(parsed.nonce);
    nonce[i] ^= 0xff;
    await flip(nonce, parsed.ciphertextAndTag);
  }
  for (let i = 0; i < parsed.ciphertextAndTag.byteLength; i++) {
    const body = new Uint8Array(parsed.ciphertextAndTag);
    body[i] ^= 0xff;
    await flip(parsed.nonce, body);
  }
});

test("envelope validation rejects malformed input and oversize blobs", async () => {
  const nonce = bytesToBase64Url(new Uint8Array(12));
  const body = bytesToBase64Url(new Uint8Array(32));
  const good = `{"v":1,"n":"${nonce}","c":"${body}"}`;
  assert.equal(parseEnvelope(good).nonce.byteLength, 12);
  assert.throws(() => parseEnvelope(1 as unknown as string), EnvelopeError);
  assert.throws(() => parseEnvelope(""), EnvelopeError);
  assert.throws(() => parseEnvelope(good + " "), EnvelopeError);
  assert.throws(() => parseEnvelope(`{"v":1,"n":"${nonce}","c":"${body}","x":1}`), EnvelopeError);
  assert.throws(() => parseEnvelope(`{"c":"${body}","n":"${nonce}","v":1}`), EnvelopeError);
  assert.throws(() => parseEnvelope(`{"v":2,"n":"${nonce}","c":"${body}"}`), EnvelopeError);
  assert.throws(() => parseEnvelope(`{ "v":1,"n":"${nonce}","c":"${body}"}`), EnvelopeError);
  const shortNonce = bytesToBase64Url(new Uint8Array(11));
  const shortBody = bytesToBase64Url(new Uint8Array(15));
  assert.throws(() => parseEnvelope(`{"v":1,"n":"${shortNonce}","c":"${body}"}`), EnvelopeError);
  assert.throws(() => parseEnvelope(`{"v":1,"n":"${nonce}","c":"${shortBody}"}`), EnvelopeError);
  assert.throws(() => parseEnvelope("x".repeat(MAX_ENVELOPE_CHARS + 1)), EnvelopeError);
  await assert.rejects(() => sealRecord(null as unknown as CryptoKey, { ...ctx, table: "a|b" }, {}), EnvelopeError);
  await assert.rejects(() => sealRecord(null as unknown as CryptoKey, { ...ctx, id: "" }, {}), EnvelopeError);
});

test("a record above the size cap is rejected", async () => {
  const key = await dek();
  const huge = new Uint8Array(1_500_000);
  await assert.rejects(() => sealBytes(key, ctx, huge), EnvelopeError);
});

test("the DEK is not extractable and the vault refuses a locked or extractable key", async () => {
  const raw = generateDekBytes();
  assert.equal(raw.byteLength, 32);
  const key = await importDek(raw);
  raw.fill(0x5a);
  const sealed = await sealBytes(key, ctx, utf8Encode("still-works"));
  assert.equal(new TextDecoder().decode(await openBytes(key, ctx, sealed)), "still-works");
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));
  await assert.rejects(() => crypto.subtle.exportKey("jwk", key));

  const holder = new Vault();
  assert.equal(holder.isUnlocked(), false);
  assert.throws(() => holder.get(), VaultLockedError);
  holder.set(key);
  assert.equal(holder.isUnlocked(), true);
  assert.equal(holder.get(), key);
  holder.clear();
  assert.equal(holder.isUnlocked(), false);

  const extractable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  assert.throws(() => holder.set(extractable), /extractable/);
  const encryptOnly = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  assert.throws(() => holder.set(encryptOnly), /encrypt and decrypt/);
  const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  assert.throws(() => holder.set(hmac), /AES-GCM/);

  vault.clear();
  assert.equal(vault.isUnlocked(), false);
  vault.set(key);
  assert.equal(vault.get(), key);
  vault.clear();
});
