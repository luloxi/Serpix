// DEK wraps without Argon2: AAD binding, tamper, wrong IKM, non-extractable wrap key.

import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64Url, wipe } from "../lib/crypto/bytes.ts";
import { DecryptError } from "../lib/crypto/envelope.ts";
import {
  WrapError,
  assertWrap,
  deriveWrapKey,
  serializeWrap,
  unwrapDek,
  wrapDek,
  type Wrap,
} from "../lib/crypto/wrap.ts";
import { bytesToHex, hexToBytes, sequentialRng } from "./helpers/codec.ts";

const dek = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const ikm = hexToBytes("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");

function freshWrap(): Promise<Wrap> {
  return wrapDek(dek, ikm, {
    type: "backup",
    userId: "user-1",
    wrapId: "wrap-1",
    rng: sequentialRng(0xa0),
  });
}

test("wrap round trip and a non-extractable wrap key", async () => {
  const wrap = await freshWrap();
  const raw = await unwrapDek(wrap, ikm, { userId: "user-1", wrapId: "wrap-1" });
  assert.equal(bytesToHex(raw), bytesToHex(dek));
  wipe(raw);
  const salt = hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
  const key = await deriveWrapKey(ikm, salt, "backup");
  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));
  const json = serializeWrap(wrap);
  assert.equal(json, JSON.stringify({
    v: 1,
    type: "backup",
    userId: "user-1",
    wrapId: "wrap-1",
    salt: wrap.salt,
    n: wrap.n,
    c: wrap.c,
  }));
  assert.deepEqual(assertWrap(JSON.parse(json)), wrap);
});

test("wrong IKM, userId, wrapId, type, or a flipped ciphertext byte fails", async () => {
  const wrap = await freshWrap();
  const ctx = { userId: "user-1", wrapId: "wrap-1" };
  const wrongIkm = hexToBytes("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  await assert.rejects(() => unwrapDek(wrap, wrongIkm, ctx), DecryptError);
  await assert.rejects(() => unwrapDek(wrap, ikm, { userId: "user-2", wrapId: "wrap-1" }), DecryptError);
  await assert.rejects(() => unwrapDek(wrap, ikm, { userId: "user-1", wrapId: "wrap-2" }), DecryptError);

  const moved: Wrap = { ...wrap, userId: "user-2" };
  await assert.rejects(() => unwrapDek(moved, ikm, { userId: "user-2", wrapId: "wrap-1" }), DecryptError);
  const retyped: Wrap = { ...wrap, type: "other" };
  await assert.rejects(() => unwrapDek(retyped, ikm, ctx), DecryptError);

  const body = Uint8Array.from(Buffer.from(wrap.c, "base64url"));
  body[0] ^= 0xff;
  body[47] ^= 0x01;
  const tampered: Wrap = { ...wrap, c: bytesToBase64Url(body) };
  await assert.rejects(() => unwrapDek(tampered, ikm, ctx), DecryptError);

  const nonce = Uint8Array.from(Buffer.from(wrap.n, "base64url"));
  nonce[0] ^= 0xff;
  await assert.rejects(() => unwrapDek({ ...wrap, n: bytesToBase64Url(nonce) }, ikm, ctx), DecryptError);
});

test("assertWrap rejects a malformed wrap", async () => {
  const good = {
    v: 1,
    type: "backup",
    userId: "user-1",
    wrapId: "wrap-1",
    salt: bytesToBase64Url(new Uint8Array(32).fill(1)),
    n: bytesToBase64Url(new Uint8Array(12).fill(2)),
    c: bytesToBase64Url(new Uint8Array(48).fill(3)),
  };
  assert.equal(assertWrap(good).type, "backup");
  assert.throws(() => assertWrap(null), WrapError);
  assert.throws(() => assertWrap({ ...good, extra: 1 }), WrapError);
  assert.throws(() => assertWrap({ ...good, v: 2 }), WrapError);
  assert.throws(() => assertWrap({ ...good, type: "Backup" }), WrapError);
  assert.throws(() => assertWrap({ ...good, userId: "a|b" }), WrapError);
  assert.throws(() => assertWrap({ ...good, c: bytesToBase64Url(new Uint8Array(47)) }), WrapError);
  assert.throws(() => assertWrap({ ...good, type: "password" }), WrapError);
  const params = { m: 65536, t: 3, p: 1, salt: bytesToBase64Url(new Uint8Array(16).fill(4)) };
  const password = { ...good, type: "password", params };
  assert.equal(assertWrap(password).type, "password");
  assert.throws(() => assertWrap({ ...password, params: { ...params, extra: 1 } }), WrapError);
  assert.throws(() => assertWrap({ ...password, params: { ...params, m: 7 } }), WrapError);
  assert.throws(() => assertWrap({ ...password, params: { ...params, salt: bytesToBase64Url(new Uint8Array(8)) } }), WrapError);
  await assert.rejects(
    () => wrapDek(dek, ikm.slice(0, 16), { type: "backup", userId: "user-1", wrapId: "wrap-1" }),
    WrapError,
  );
});
