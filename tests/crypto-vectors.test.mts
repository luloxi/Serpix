// Known-answer tests.
// AES-256-GCM: McGrew & Viega / NIST SP 800-38D CAVP Test Case 16 (96-bit IV, non-empty AAD, 128-bit tag).
// HKDF-SHA-256: RFC 5869 A.1 test case 1 and A.3 test case 3.
// Argon2id: phc-winner-argon2 src/test.c (v=19, t=2, m=256 KiB, p=1). hash-wasm has `secret` but no
// associated-data parameter, so RFC 9106 §5.3 (which sets both) cannot be reproduced.
// Envelope and wrap goldens are also checked against node:crypto with a fixed RNG.

import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import { bytesToBase64Url } from "../lib/crypto/bytes.ts";
import { importDek } from "../lib/crypto/dek.ts";
import { aesGcmOpen, aesGcmSeal, openRecord, sealRecord } from "../lib/crypto/envelope.ts";
import { deriveArgon2id } from "../lib/crypto/password.ts";
import { hkdfSha256, unwrapDek, wrapDek, type PasskeyParams, type PasswordParams } from "../lib/crypto/wrap.ts";
import { bytesToHex, hexToBytes, sequentialRng } from "./helpers/codec.ts";

const NIST_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const NIST_IV = "cafebabefacedbaddecaf888";
const NIST_AAD = "feedfacedeadbeeffeedfacedeadbeefabaddad2";
const NIST_PT = "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
const NIST_CT = "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662";
const NIST_TAG = "76fc6ece0f4e1768cddf8853bb2d551b";

const DEK = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const IKM = hexToBytes("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
const NONCE = hexToBytes("c0c1c2c3c4c5c6c7c8c9cacb");
const ENVELOPE = '{"v":1,"n":"wMHCw8TFxsfIycrL","c":"e2pJBhodtGS6mJnDEIDKOCMHhh0GwNwrS60vyY1fAjH6vWF2rorJ695zj8RHzKM"}';
const HKDF_SALT = hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
const WRAP_NONCE = "0NHS09TV1tfY2drb";
const PASSWORD_C = "cg4KLWcgZO39iK0Wq6DswWN2NVVOqX-9adZNnLySgJgmXTX_XH3yHhvhLBt9m1PK";
const PASSKEY_C = "-L2djdVmiG5NA5xbpo_FR_KghUr_pF2Q6APVObk2UhanyWVo5aqtskQy4Ly5zXcr";
const SALT_B64 = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8";

test("AES-256-GCM with AAD matches NIST SP 800-38D test case 16", async () => {
  const key = await importDek(hexToBytes(NIST_KEY));
  const iv = hexToBytes(NIST_IV);
  const aad = hexToBytes(NIST_AAD);
  const pt = hexToBytes(NIST_PT);
  const sealed = await aesGcmSeal(key, iv, pt, aad);
  assert.equal(bytesToHex(sealed), NIST_CT + NIST_TAG);
  const opened = await aesGcmOpen(key, iv, sealed, aad);
  assert.equal(bytesToHex(opened), NIST_PT);
});

test("HKDF-SHA-256 matches RFC 5869 test cases 1 and 3", async () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = hexToBytes("000102030405060708090a0b0c");
  const info = hexToBytes("f0f1f2f3f4f5f6f7f8f9");
  const case1 = await hkdfSha256(ikm, salt, info, 42);
  assert.equal(
    bytesToHex(case1),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
  );
  assert.equal(bytesToHex(case1), Buffer.from(hkdfSync("sha256", ikm, salt, info, 42)).toString("hex"));

  const case3 = await hkdfSha256(ikm, new Uint8Array(), new Uint8Array(), 42);
  const expected3 = "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8";
  assert.equal(bytesToHex(case3), expected3);
  assert.equal(bytesToHex(case3), Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.alloc(0), 42)).toString("hex"));
});

test("Argon2id matches the phc-winner-argon2 m=256 vector, including NFKC", async () => {
  const salt = new TextEncoder().encode("somesalt");
  const hash = await deriveArgon2id("password", salt, { m: 256, t: 2, p: 1 });
  assert.equal(bytesToHex(hash), "9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe");
  const composed = await deriveArgon2id("é", salt, { m: 256, t: 2, p: 1 });
  const decomposed = await deriveArgon2id("e\u0301", salt, { m: 256, t: 2, p: 1 });
  assert.equal(bytesToHex(decomposed), bytesToHex(composed));
});

test("envelope golden with an injected nonce", async () => {
  const key = await importDek(DEK);
  const record = { note: "Ñandú", name: "Ada" };
  const envelope = await sealRecord(key, { table: "contacts", id: "row-1", userId: "user-1" }, record, () => NONCE);
  assert.equal(envelope, ENVELOPE);
  assert.deepEqual(await openRecord(key, { table: "contacts", id: "row-1", userId: "user-1" }, envelope), {
    name: "Ada",
    note: "Ñandú",
  });

  const aad = Buffer.from("contacts|row-1|user-1", "utf8");
  const pt = Buffer.from('{"name":"Ada","note":"Ñandú"}', "utf8");
  const cipher = createCipheriv("aes-256-gcm", DEK, NONCE);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
  assert.equal(bytesToBase64Url(NONCE), "wMHCw8TFxsfIycrL");
  assert.equal(bytesToBase64Url(ct), "e2pJBhodtGS6mJnDEIDKOCMHhh0GwNwrS60vyY1fAjH6vWF2rorJ695zj8RHzKM");
});

test("wrap goldens for password and passkey types", async () => {
  for (const sample of [
    { type: "password", wrapId: "wrap-1", c: PASSWORD_C, okm: "6a6c4efc4de792a8342df43b6b72529e9bef270b9e580b9d63cb820d417c0167" },
    { type: "passkey", wrapId: "wrap-pk", c: PASSKEY_C, okm: "7505f4a941a5deb55711407ffb7e73da6b16f042351bc2e88560037cd47d6c0a" },
  ]) {
    const info = Buffer.from(`serpix-e2e/v1/wrap/${sample.type}`, "utf8");
    const okm = Buffer.from(hkdfSync("sha256", IKM, HKDF_SALT, info, 32));
    assert.equal(okm.toString("hex"), sample.okm);
    const derived = await hkdfSha256(IKM, HKDF_SALT, info, 32);
    assert.equal(bytesToHex(derived), sample.okm);

    const params: PasswordParams | PasskeyParams = sample.type === "password"
      ? { m: 65536, t: 3, p: 1, salt: bytesToBase64Url(new Uint8Array(16).fill(1)) }
      : {
          prfSalt: bytesToBase64Url(new Uint8Array(32).fill(2)),
          credentialId: bytesToBase64Url(new Uint8Array(16).fill(3)),
        };
    const wrap = await wrapDek(DEK, IKM, {
      type: sample.type,
      userId: "user-1",
      wrapId: sample.wrapId,
      saltFn: () => HKDF_SALT,
      rng: sequentialRng(0xd0),
      params,
    });
    assert.equal(wrap.v, 1);
    assert.equal(wrap.salt, SALT_B64);
    assert.equal(wrap.n, WRAP_NONCE);
    assert.equal(wrap.c, sample.c);
    assert.equal(wrap.userId, "user-1");
    assert.equal(wrap.wrapId, sample.wrapId);

    const nodeNonce = Buffer.from("d0d1d2d3d4d5d6d7d8d9dadb", "hex");
    // Password wraps bind the Argon2id cost. Passkey wraps do not. HKDF and the nonce stay as published.
    const cost = sample.type === "password" ? "|65536|3|1" : "";
    const nodeAad = Buffer.from(`wrap|${sample.type}|user-1|${sample.wrapId}${cost}`, "utf8");
    const nodeCipher = createCipheriv("aes-256-gcm", okm, nodeNonce);
    nodeCipher.setAAD(nodeAad);
    const nodeCt = Buffer.concat([nodeCipher.update(DEK), nodeCipher.final(), nodeCipher.getAuthTag()]);
    assert.equal(Buffer.from(nodeCt).toString("base64url"), sample.c);

    const opened = await unwrapDek(wrap, IKM, { userId: "user-1", wrapId: sample.wrapId });
    assert.equal(bytesToHex(opened), bytesToHex(DEK));
  }
});
