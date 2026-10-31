// Byte helpers: base64url, utf-8, concat, equality, wipe.

import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concat,
  copyBytes,
  isBoundComponent,
  randomBytes,
  timingSafeEqual,
  utf8Decode,
  utf8Encode,
  wipe,
} from "../lib/crypto/bytes.ts";
import { bytesToHex, hexToBytes } from "./helpers/codec.ts";

test("base64url matches Node and has no padding", () => {
  const samples = [
    new Uint8Array(),
    hexToBytes("00"),
    hexToBytes("ff"),
    hexToBytes("fbff"),
    hexToBytes("ffff"),
    hexToBytes("000102030405060708090a0b0c0d0e0f"),
    utf8Encode("Ñandú / + ="),
  ];
  for (const sample of samples) {
    const encoded = bytesToBase64Url(sample);
    assert.equal(encoded.includes("="), false);
    assert.equal(encoded.includes("+"), false);
    assert.equal(encoded.includes("/"), false);
    assert.equal(encoded, Buffer.from(sample).toString("base64url"));
    assert.deepEqual(base64UrlToBytes(encoded), sample);
  }
});

test("base64url rejects padding, bad alphabet, and a length of 4k+1", () => {
  assert.throws(() => base64UrlToBytes("qq=="), /invalid base64url/);
  assert.throws(() => base64UrlToBytes("qqq="), /invalid base64url/);
  assert.throws(() => base64UrlToBytes("ab+c"), /invalid base64url/);
  assert.throws(() => base64UrlToBytes("ab/c"), /invalid base64url/);
  assert.throws(() => base64UrlToBytes("abcde"), /invalid base64url/);
  assert.throws(() => base64UrlToBytes("ab c"), /invalid base64url/);
});

test("utf8, concat, copy and random bytes", () => {
  const text = "bóveda — Ñandú";
  assert.equal(utf8Decode(utf8Encode(text)), text);
  assert.throws(() => utf8Decode(Uint8Array.of(0xff)));
  const joined = concat(utf8Encode("aa"), Uint8Array.of(0), utf8Encode("b"));
  assert.equal(bytesToHex(joined), "61610062");
  const source = Uint8Array.of(1, 2, 3);
  const copied = copyBytes(source);
  source[0] = 9;
  assert.deepEqual(copied, Uint8Array.of(1, 2, 3));
  assert.equal(randomBytes(32).byteLength, 32);
  assert.equal(randomBytes(0).byteLength, 0);
});

test("timingSafeEqual checks every byte and rejects a different length", () => {
  const left = Uint8Array.of(1, 2, 3, 4);
  assert.equal(timingSafeEqual(left, Uint8Array.of(1, 2, 3, 4)), true);
  assert.equal(timingSafeEqual(left, Uint8Array.of(1, 2, 3, 5)), false);
  assert.equal(timingSafeEqual(left, Uint8Array.of(1, 2, 3)), false);
  assert.equal(timingSafeEqual(new Uint8Array(), new Uint8Array()), true);
});

test("isBoundComponent accepts an id and rejects separators, controls and empty", () => {
  assert.equal(isBoundComponent("user-1"), true);
  assert.equal(isBoundComponent("Ñ"), true);
  assert.equal(isBoundComponent(""), false);
  assert.equal(isBoundComponent("a|b"), false);
  assert.equal(isBoundComponent("a\nb"), false);
  assert.equal(isBoundComponent("a\u0000b"), false);
  assert.equal(isBoundComponent("x".repeat(256)), true);
  assert.equal(isBoundComponent("x".repeat(257)), false);
});

test("wipe overwrites the buffer", () => {
  const secret = Uint8Array.of(1, 2, 3, 255);
  wipe(secret);
  assert.deepEqual(secret, Uint8Array.of(0, 0, 0, 0));
});
