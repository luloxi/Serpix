// Password strength is instant. The Argon2id cases at 64 MiB / 46 MiB are the slow ones.

import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64Url, wipe } from "../lib/crypto/bytes.ts";
import { DecryptError } from "../lib/crypto/envelope.ts";
import {
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  ARGON2_MEMORY_SLOW_KIB,
  ARGON2_PARALLELISM,
  codePointLength,
  createPasswordWrap,
  openPasswordWrap,
  passwordStrength,
  validateRecoveryPassword,
  PasswordPolicyError,
  type PasswordParams,
} from "../lib/crypto/password.ts";
import { WrapError, assertWrap, type Wrap } from "../lib/crypto/wrap.ts";
import { hexToBytes } from "./helpers/codec.ts";

const dek = hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
const ctx = { userId: "user-1", wrapId: "wrap-1" };

test("length is counted in code points after NFKC", () => {
  assert.equal(codePointLength("á".repeat(12)), 12);
  assert.equal(codePointLength("a\u0301".repeat(12)), 12);
  assert.equal("😀".repeat(6).length, 12);
  assert.equal(codePointLength("😀".repeat(6)), 6);
  assert.throws(() => validateRecoveryPassword("a\u0301".repeat(12)), PasswordPolicyError);
  const emoji = passwordStrength("😀".repeat(6));
  assert.equal(emoji.score, 0);
  assert.ok(emoji.issues.includes("too-short"));
  assert.throws(() => validateRecoveryPassword("😀".repeat(6)), PasswordPolicyError);
});

test("weak passwords are rejected and a strong one is accepted", () => {
  const common = passwordStrength("administrador");
  assert.equal(common.score, 1);
  assert.equal(common.label, "weak");
  assert.deepEqual(common.issues, ["common"]);
  assert.throws(() => validateRecoveryPassword("administrador"), PasswordPolicyError);

  const listed = passwordStrength("password1234");
  assert.equal(listed.score, 1);
  assert.ok(listed.issues.includes("common"));
  assert.ok(listed.issues.includes("too-short") === false);
  assert.throws(() => validateRecoveryPassword("password1234"), PasswordPolicyError);

  const repeated = passwordStrength("aaaaaaaaaaaa");
  assert.equal(repeated.score, 1);
  assert.deepEqual(repeated.issues, ["repeated"]);
  assert.throws(() => validateRecoveryPassword("aaaaaaaaaaaa"), PasswordPolicyError);

  const sequential = passwordStrength("Abcdefghijkl");
  assert.equal(sequential.score, 1);
  assert.deepEqual(sequential.issues, ["sequential"]);
  assert.throws(() => validateRecoveryPassword("Abcdefghijkl"), PasswordPolicyError);

  const rows = passwordStrength("opasopasopas");
  assert.equal(rows.score, 2);
  assert.equal(rows.label, "fair");
  assert.deepEqual(rows.issues, []);
  assert.equal(validateRecoveryPassword("opasopasopas").score, 2);

  const strong = passwordStrength("Correct-Horse-99");
  assert.equal(strong.score, 4);
  assert.equal(strong.label, "very strong");
  assert.deepEqual(strong.issues, []);
  assert.equal(validateRecoveryPassword("Correct-Horse-99").score, 4);

  const mixed = passwordStrength("Tr0ub4dor&3xy");
  assert.ok(mixed.score >= 2);
  validateRecoveryPassword("Tr0ub4dor&3xy");
  assert.equal(codePointLength("Áb1!Áb1!Áb1!"), 12);
  assert.ok(validateRecoveryPassword("Áb1!Áb1!Áb1!").score >= 2);
});

test("an email or its local part on a boundary lowers the score", () => {
  const plain = passwordStrength("luciano-serpix");
  assert.equal(plain.score, 2);
  assert.deepEqual(plain.issues, []);
  validateRecoveryPassword("luciano-serpix");

  const penalised = passwordStrength("luciano-serpix", ["luciano@example.com"]);
  assert.equal(penalised.score, 1);
  assert.equal(penalised.label, "weak");
  assert.deepEqual(penalised.issues, ["user-input"]);
  assert.throws(() => validateRecoveryPassword("luciano-serpix", ["luciano@example.com"]), PasswordPolicyError);

  const full = passwordStrength("Keep-luciano@example.com");
  const withEmail = passwordStrength("Keep-luciano@example.com", ["luciano@example.com"]);
  assert.equal(withEmail.score, full.score - 1);
  assert.ok(withEmail.issues.includes("user-input"));
  assert.equal(passwordStrength("luciano-serpix", ["other@example.com"]).score, 2);
});

test("password wrap round trip, wrong password, and stored m", { timeout: 180_000 }, async () => {
  const wrap = await createPasswordWrap(dek, "Correct-Horse-99", {
    ...ctx,
    timer: { elapsed: () => 50 },
  });
  const params = wrap.params as PasswordParams;
  assert.equal(params.m, ARGON2_MEMORY_KIB);
  assert.equal(params.t, ARGON2_ITERATIONS);
  assert.equal(params.p, ARGON2_PARALLELISM);
  assert.equal(Buffer.from(params.salt, "base64url").byteLength, 16);

  const opened = await openPasswordWrap(wrap, "Correct-Horse-99", ctx);
  try {
    assert.equal(Buffer.from(opened).toString("hex"), Buffer.from(dek).toString("hex"));
  } finally {
    wipe(opened);
  }
  await assert.rejects(() => openPasswordWrap(wrap, "Wrong-Horse-99!!", ctx), DecryptError);
});

test("openPasswordWrap rejects argon2 costs outside the two presets before deriving", async () => {
  const kdfSalt = bytesToBase64Url(new Uint8Array(16).fill(9));
  const shell = (cost: { m: number; t: number; p: number }): Wrap => ({
    v: 1,
    type: "password",
    userId: ctx.userId,
    wrapId: ctx.wrapId,
    salt: bytesToBase64Url(new Uint8Array(32).fill(1)),
    n: bytesToBase64Url(new Uint8Array(12).fill(2)),
    c: bytesToBase64Url(new Uint8Array(48).fill(3)),
    params: { ...cost, salt: kdfSalt },
  });
  // m=8 is first: on the old floor it is legal, so a failure stops before m=262144 could run the KDF.
  const hostile = [
    { m: 8, t: 3, p: 1 },
    { m: 19456, t: 3, p: 1 },
    { m: 65536, t: 1, p: 1 },
    { m: 65536, t: 10, p: 1 },
    { m: 65536, t: 3, p: 2 },
    { m: 262144, t: 3, p: 1 },
  ];
  let calls = 0;
  const derive = async () => {
    calls += 1;
    throw new Error("kdf was reached");
  };
  for (const cost of hostile) {
    calls = 0;
    const wrap = shell(cost);
    assert.throws(() => assertWrap(wrap), WrapError);
    const started = performance.now();
    await assert.rejects(() => openPasswordWrap(wrap, "Correct-Horse-99", { ...ctx, derive }), WrapError);
    assert.equal(calls, 0);
    if (cost.m === 262144) assert.ok(performance.now() - started < 250);
  }
  for (const m of [ARGON2_MEMORY_KIB, ARGON2_MEMORY_SLOW_KIB]) {
    const accepted = assertWrap(shell({ m, t: ARGON2_ITERATIONS, p: ARGON2_PARALLELISM }));
    assert.equal((accepted.params as PasswordParams).m, m);
    assert.equal((accepted.params as PasswordParams).t, ARGON2_ITERATIONS);
    assert.equal((accepted.params as PasswordParams).p, ARGON2_PARALLELISM);
  }
});

test("a timer of exactly 2000 ms keeps the 64 MiB parameter", { timeout: 120_000 }, async () => {
  const wrap = await createPasswordWrap(dek, "Correct-Horse-99", {
    ...ctx,
    timer: { elapsed: () => 2000 },
  });
  assert.equal((wrap.params as PasswordParams).m, ARGON2_MEMORY_KIB);
});

test("a timer above 2000 ms rewraps at 46 MiB and open uses that m", { timeout: 180_000 }, async () => {
  const wrap = await createPasswordWrap(dek, "Correct-Horse-99", {
    ...ctx,
    timer: { elapsed: () => 2001 },
  });
  const params = wrap.params as PasswordParams;
  assert.equal(params.m, ARGON2_MEMORY_SLOW_KIB);
  assert.equal(params.t, ARGON2_ITERATIONS);
  assert.equal(params.p, ARGON2_PARALLELISM);
  const opened = await openPasswordWrap(wrap, "Correct-Horse-99", ctx);
  try {
    assert.equal(Buffer.from(opened).toString("hex"), Buffer.from(dek).toString("hex"));
  } finally {
    wipe(opened);
  }
  await assert.rejects(
    () => openPasswordWrap(wrap, "Correct-Horse-99", { userId: "user-2", wrapId: ctx.wrapId }),
    DecryptError,
  );
});
