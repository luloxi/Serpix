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
  type Argon2Params,
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
  assert.deepEqual(common.issues, ["common", "single-class", "low-score"]);
  assert.throws(() => validateRecoveryPassword("administrador"), PasswordPolicyError);

  const listed = passwordStrength("password1234");
  assert.equal(listed.score, 1);
  assert.ok(listed.issues.includes("common"));
  assert.ok(listed.issues.includes("sequential"));
  assert.ok(listed.issues.includes("low-score"));
  assert.equal(listed.issues.includes("single-class"), false);
  assert.ok(listed.issues.includes("too-short") === false);
  assert.throws(() => validateRecoveryPassword("password1234"), PasswordPolicyError);

  const repeated = passwordStrength("aaaaaaaaaaaa");
  assert.equal(repeated.score, 1);
  assert.deepEqual(repeated.issues, ["repeated", "single-class", "low-score"]);
  assert.throws(() => validateRecoveryPassword("aaaaaaaaaaaa"), PasswordPolicyError);

  const sequential = passwordStrength("Abcdefghijkl");
  assert.equal(sequential.score, 1);
  assert.deepEqual(sequential.issues, ["sequential", "low-score"]);
  assert.throws(() => validateRecoveryPassword("Abcdefghijkl"), PasswordPolicyError);

  const rows = passwordStrength("opasopasopas");
  assert.equal(rows.score, 2);
  assert.equal(rows.label, "fair");
  assert.deepEqual(rows.issues, ["single-class", "low-score"]);
  assert.throws(() => validateRecoveryPassword("opasopasopas"), (error: unknown) => {
    assert.ok(error instanceof PasswordPolicyError);
    assert.equal(error.score, 2);
    assert.deepEqual(error.issues, ["single-class", "low-score"]);
    return true;
  });

  const strong = passwordStrength("Correct-Horse-99");
  assert.equal(strong.score, 4);
  assert.equal(strong.label, "very strong");
  assert.deepEqual(strong.issues, []);
  assert.equal(validateRecoveryPassword("Correct-Horse-99").score, 4);

  const mixed = passwordStrength("Tr0ub4dor&3xy");
  assert.ok(mixed.score >= 3);
  assert.ok(validateRecoveryPassword("Tr0ub4dor&3xy").score >= 3);
  assert.equal(codePointLength("Áb1!Áb1!Áb1!"), 12);
  assert.ok(validateRecoveryPassword("Áb1!Áb1!Áb1!").score >= 3);
});

test("recovery password needs score 3 and at least two character classes", () => {
  const rejected = (password: string, userInputs?: string[]): PasswordPolicyError => {
    try {
      validateRecoveryPassword(password, userInputs);
    } catch (error) {
      assert.ok(error instanceof PasswordPolicyError);
      return error;
    }
    assert.fail("expected PasswordPolicyError");
  };

  const lower12 = "xkcdpassworx";
  assert.equal(codePointLength(lower12), 12);
  const lower12Error = rejected(lower12);
  assert.equal(lower12Error.score, 2);
  assert.deepEqual(lower12Error.issues, ["single-class", "low-score"]);

  const rowsError = rejected("opasopasopas");
  assert.equal(rowsError.score, 2);
  assert.ok(rowsError.issues.includes("single-class"));
  assert.ok(rowsError.issues.includes("low-score"));

  const three = "BlueHorse99x";
  assert.equal(codePointLength(three), 12);
  const acceptedThree = validateRecoveryPassword(three);
  assert.equal(acceptedThree.score, 3);
  assert.equal(acceptedThree.issues.includes("single-class"), false);
  assert.equal(acceptedThree.issues.includes("low-score"), false);

  const twoClass = "CorrectHorse";
  assert.equal(codePointLength(twoClass), 12);
  const twoClassError = rejected(twoClass);
  assert.equal(twoClassError.score, 2);
  assert.deepEqual(twoClassError.issues, ["low-score"]);

  const lower16 = "opasopasopasopas";
  assert.equal(codePointLength(lower16), 16);
  const lower16Error = rejected(lower16);
  assert.equal(lower16Error.score, 3);
  assert.deepEqual(lower16Error.issues, ["single-class"]);

  const phrase = "correct horse bat";
  assert.ok(codePointLength(phrase) >= 16);
  const acceptedPhrase = validateRecoveryPassword(phrase);
  assert.equal(acceptedPhrase.score, 3);
  assert.deepEqual(acceptedPhrase.issues, []);

  const common = rejected("administrador");
  assert.ok(common.issues.includes("common"));
  assert.ok(common.issues.includes("low-score"));
  const sequential = rejected("Abcdefghijkl");
  assert.ok(sequential.issues.includes("sequential"));
  const repeated = rejected("aaaaaaaaaaaa");
  assert.ok(repeated.issues.includes("repeated"));
  const personal = rejected("luciano-serpix", ["luciano@example.com"]);
  assert.ok(personal.issues.includes("user-input"));
  assert.equal(personal.score < 3, true);
});

test("an email or its local part on a boundary lowers the score", () => {
  const plain = passwordStrength("luciano-serpix");
  assert.equal(plain.score, 2);
  assert.deepEqual(plain.issues, ["low-score"]);
  assert.throws(() => validateRecoveryPassword("luciano-serpix"), PasswordPolicyError);

  const penalised = passwordStrength("luciano-serpix", ["luciano@example.com"]);
  assert.equal(penalised.score, 1);
  assert.equal(penalised.label, "weak");
  assert.deepEqual(penalised.issues, ["user-input", "low-score"]);
  assert.throws(() => validateRecoveryPassword("luciano-serpix", ["luciano@example.com"]), (error: unknown) => {
    assert.ok(error instanceof PasswordPolicyError);
    assert.ok(error.issues.includes("user-input"));
    assert.ok(error.issues.includes("low-score"));
    return true;
  });

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

function fillRng(fill: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(fill);
}

function isWarmCost(params: Argon2Params): boolean {
  return params.m === 8 && params.t === 1 && params.p === 1;
}

test("warm-up finishes before the clock and stays outside the timed window", async () => {
  const events: string[] = [];
  let clock = 0;
  const warmHash = new Uint8Array(32).fill(7);
  let warmSalt: Uint8Array | null = null;
  const userPassword = "Correct-Horse-99";
  const kdfSalt = new Uint8Array(16).fill(0xab);
  let rngCalls = 0;
  const wrap = await createPasswordWrap(dek, userPassword, {
    ...ctx,
    now: () => {
      events.push("now");
      return clock;
    },
    derive: async (password, salt, params) => {
      if (isWarmCost(params)) {
        events.push("warm");
        assert.notEqual(password, userPassword);
        assert.equal(salt.byteLength, 16);
        assert.ok(salt.some((byte) => byte !== 0xab));
        warmSalt = salt;
        clock += 5_000;
        return warmHash;
      }
      events.push(`derive:${params.m}`);
      assert.equal(password, userPassword);
      assert.equal(params.t, ARGON2_ITERATIONS);
      assert.equal(params.p, ARGON2_PARALLELISM);
      assert.deepEqual(Buffer.from(salt), Buffer.from(kdfSalt));
      clock += 40;
      return new Uint8Array(32).fill(9);
    },
    rng: (length) => {
      rngCalls += 1;
      if (rngCalls === 1) return kdfSalt.slice();
      return new Uint8Array(length);
    },
  });
  assert.equal((wrap.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.deepEqual(events, ["warm", "now", "derive:65536", "now"]);
  assert.ok(warmSalt);
  assert.ok(warmSalt.every((byte) => byte === 0));
  assert.ok(warmHash.every((byte) => byte === 0));
});

test("warm-up uses one fixed dummy and runs once per derive", async () => {
  async function sample(userPassword: string) {
    const seen = { password: "", salt: new Uint8Array(), calls: 0 };
    const derive = async (password: string, salt: Uint8Array, params: Argon2Params) => {
      if (isWarmCost(params)) {
        seen.calls += 1;
        seen.password = password;
        seen.salt = Uint8Array.from(salt);
        assert.notEqual(password, userPassword);
        assert.equal(salt.byteLength, 16);
        assert.ok(salt.some((byte) => byte !== 0xcd));
      } else {
        assert.equal(password, userPassword);
        assert.equal(params.m, ARGON2_MEMORY_KIB);
        assert.deepEqual(Buffer.from(salt), Buffer.from(new Uint8Array(16).fill(0xcd)));
      }
      return new Uint8Array(32);
    };
    const options = { ...ctx, derive, timer: { elapsed: () => 50 }, rng: fillRng(0xcd) };
    const first = await createPasswordWrap(dek, userPassword, options);
    const second = await createPasswordWrap(dek, userPassword, options);
    assert.equal((first.params as PasswordParams).m, ARGON2_MEMORY_KIB);
    assert.equal((second.params as PasswordParams).m, ARGON2_MEMORY_KIB);
    assert.equal(seen.calls, 1);
    return seen;
  }
  const first = await sample("Correct-Horse-99");
  const second = await sample("Another-Phrase-1");
  assert.equal(first.password, second.password);
  assert.deepEqual(first.salt, second.salt);
});

test("concurrent wraps share one in-flight warm-up", async () => {
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const derive = async (_password: string, _salt: Uint8Array, params: Argon2Params) => {
    if (isWarmCost(params)) {
      entered += 1;
      await gate;
    }
    return new Uint8Array(32);
  };
  const options = { ...ctx, derive, timer: { elapsed: () => 10 }, rng: fillRng(0) };
  const pending = Promise.all([
    createPasswordWrap(dek, "Correct-Horse-99", options),
    createPasswordWrap(dek, "Correct-Horse-99", options),
  ]);
  assert.equal(entered, 1);
  release();
  const [first, second] = await pending;
  assert.equal((first.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.equal((second.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.equal(entered, 1);
});

test("a warm-up failure still creates the wrap and is not retried", async () => {
  let attempts = 0;
  let warmSalt: Uint8Array | null = null;
  const derive = async (_password: string, salt: Uint8Array, params: Argon2Params) => {
    if (isWarmCost(params)) {
      attempts += 1;
      warmSalt = salt;
      throw new Error("wasm instantiate failed");
    }
    assert.equal(params.m, ARGON2_MEMORY_KIB);
    return new Uint8Array(32);
  };
  const options = { ...ctx, derive, timer: { elapsed: () => 50 }, rng: fillRng(1) };
  const first = await createPasswordWrap(dek, "Correct-Horse-99", options);
  const second = await createPasswordWrap(dek, "Correct-Horse-99", options);
  assert.equal((first.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.equal((second.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.equal(attempts, 1);
  assert.ok(warmSalt);
  assert.ok(warmSalt.every((byte) => byte === 0));
});

test("the injected timer is read after warm-up and still selects the slow cost", async () => {
  const events: string[] = [];
  const slow = await createPasswordWrap(dek, "Correct-Horse-99", {
    ...ctx,
    now: () => {
      events.push("now");
      return 0;
    },
    timer: {
      elapsed: () => {
        events.push("timer");
        return 2001;
      },
    },
    derive: async (_password, _salt, params) => {
      events.push(`m=${params.m}`);
      return new Uint8Array(32);
    },
    rng: fillRng(2),
  });
  assert.equal((slow.params as PasswordParams).m, ARGON2_MEMORY_SLOW_KIB);
  assert.deepEqual(events, ["m=8", "now", "m=65536", "timer", "m=47104"]);

  events.length = 0;
  const kept = await createPasswordWrap(dek, "Correct-Horse-99", {
    ...ctx,
    now: () => {
      events.push("now");
      return 0;
    },
    timer: {
      elapsed: () => {
        events.push("timer");
        return 2000;
      },
    },
    derive: async (_password, _salt, params) => {
      events.push(`m=${params.m}`);
      return new Uint8Array(32);
    },
    rng: fillRng(3),
  });
  assert.equal((kept.params as PasswordParams).m, ARGON2_MEMORY_KIB);
  assert.deepEqual(events, ["m=8", "now", "m=65536", "timer"]);
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
