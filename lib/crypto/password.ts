// Recovery-password KDF and the strength rules for it.
// Argon2id via hash-wasm (memorySize is KiB). No word list and no 12-word phrase.
// hash-wasm accepts an optional `secret` but not associated data, so the RFC 9106 §5.3
// vector (which sets both) is not used here. Production derivation passes neither.

import { argon2id } from "hash-wasm";
import { base64UrlToBytes, bytesToBase64Url, copyBytes, randomBytes, wipe } from "./bytes.ts";
import { DecryptError, type ByteRng } from "./envelope.ts";
import { assertWrap, unwrapDek, wrapDek, WrapError, type PasswordParams, type Wrap } from "./wrap.ts";

/** 64 MiB. The setup default. */
export const ARGON2_MEMORY_KIB = 65_536;
/** 46 MiB. Used when the 64 MiB derivation takes more than two seconds. */
export const ARGON2_MEMORY_SLOW_KIB = 47_104;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_SLOW_MS = 2_000;

export type Argon2Params = { m: number; t: number; p: number };

export type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: "very weak" | "weak" | "fair" | "strong" | "very strong";
  issues: string[];
};

export class PasswordPolicyError extends Error {
  readonly score: number;
  readonly label: string;
  readonly issues: string[];

  constructor(result: PasswordStrength) {
    super(`recovery password rejected (${result.label})`);
    this.name = "PasswordPolicyError";
    this.score = result.score;
    this.label = result.label;
    this.issues = result.issues;
  }
}

const LABELS = ["very weak", "weak", "fair", "strong", "very strong"] as const;

/**
 * Very common passwords, including a few Spanish ones. Exact match after NFKC + lowercase.
 * Kept short on purpose: this is a reject-list, not a cracker dictionary.
 */
const COMMON_PASSWORDS = [
  "password", "password1", "password12", "password123", "password1234",
  "123456", "1234567", "12345678", "123456789", "1234567890",
  "qwerty", "qwerty123", "qwertyuiop", "abc123", "abcd1234",
  "letmein", "welcome", "admin", "admin123", "administrador",
  "iloveyou", "monkey", "dragon", "master", "login", "princess",
  "solo", "passw0rd", "changeme", "secret", "secreto",
  "contraseña", "contrasena", "contraseña1", "contrasena1", "contraseña12", "contrasena123",
  "clave", "clave123", "clave1234",
  "argentina", "bienvenido", "bienvenido1", "bienvenido12", "bienvenida",
  "temporal", "cambiame", "invitado", "usuario", "usuario123",
  "serpix", "serpix123", "tequiero", "mariposa", "soleado", "amorcito",
  "111111", "000000", "123123", "654321",
  "football", "baseball", "sunshine", "shadow", "trustno1",
  "hola1234", "hola12345",
];

const COMMON = new Set(COMMON_PASSWORDS);

const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

export type ElapsedTimer = { elapsed: () => number };

export type PasswordWrapOptions = {
  userId: string;
  wrapId: string;
  /** Monotonic clock in milliseconds. Two calls bracket the first derivation. Default: performance.now. */
  now?: () => number;
  /**
   * When set, replaces the measured elapsed time. `{ elapsed: () => 2_500 }` forces the 46 MiB retry.
   * Production leaves this unset.
   */
  timer?: ElapsedTimer;
  /** First call is the 16-byte Argon2 salt; wrapDek then draws the HKDF salt and the nonce. */
  rng?: ByteRng;
};

function assertArgonParams(params: Argon2Params): void {
  if (!Number.isInteger(params.m) || params.m < 8 || params.m > 262_144) throw new Error("invalid argon2 memory");
  if (!Number.isInteger(params.t) || params.t < 1 || params.t > 10) throw new Error("invalid argon2 iterations");
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 4) throw new Error("invalid argon2 parallelism");
  if (params.m < 8 * params.p) throw new Error("argon2 memory is below 8*p");
}

/** NFKC, then Argon2id. `m` is KiB, as hash-wasm's `memorySize`. Output is 32 bytes. */
export async function deriveArgon2id(password: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  assertArgonParams(params);
  if (salt.byteLength < 8) throw new Error("argon2 salt must be at least 8 bytes");
  const hash = await argon2id({
    password: password.normalize("NFKC"),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: "binary",
  });
  return copyBytes(hash);
}

export async function createPasswordWrap(
  dekRaw: Uint8Array,
  password: string,
  options: PasswordWrapOptions,
): Promise<Wrap> {
  const rng = options.rng ?? randomBytes;
  const kdfSalt = copyBytes(rng(16));
  if (kdfSalt.byteLength !== 16) throw new WrapError("argon2 salt must be 16 bytes");
  const now = options.now ?? (() => performance.now());
  let memory: number = ARGON2_MEMORY_KIB;
  const started = now();
  let ikm = await deriveArgon2id(password, kdfSalt, {
    m: memory,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
  });
  const elapsed = options.timer ? options.timer.elapsed() : now() - started;
  if (!Number.isFinite(elapsed)) {
    wipe(ikm);
    wipe(kdfSalt);
    throw new Error("argon2 timer did not return a finite duration");
  }
  if (elapsed > ARGON2_SLOW_MS) {
    wipe(ikm);
    memory = ARGON2_MEMORY_SLOW_KIB;
    ikm = await deriveArgon2id(password, kdfSalt, {
      m: memory,
      t: ARGON2_ITERATIONS,
      p: ARGON2_PARALLELISM,
    });
  }
  try {
    const params: PasswordParams = {
      m: memory,
      t: ARGON2_ITERATIONS,
      p: ARGON2_PARALLELISM,
      salt: bytesToBase64Url(kdfSalt),
    };
    return await wrapDek(dekRaw, ikm, {
      type: "password",
      userId: options.userId,
      wrapId: options.wrapId,
      rng,
      params,
    });
  } finally {
    wipe(ikm);
    wipe(kdfSalt);
  }
}

export async function openPasswordWrap(
  wrap: Wrap,
  password: string,
  ctx: { userId: string; wrapId: string },
): Promise<Uint8Array> {
  const parsed = assertWrap(wrap);
  if (parsed.type !== "password" || !parsed.params || !("m" in parsed.params)) {
    throw new WrapError("not a password wrap");
  }
  const params: PasswordParams = parsed.params;
  // A mismatched id cannot be the right AAD. Fail before the memory-hard KDF.
  if (parsed.userId !== ctx.userId || parsed.wrapId !== ctx.wrapId) throw new DecryptError("decrypt failed");
  const salt = base64UrlToBytes(params.salt);
  const ikm = await deriveArgon2id(password, salt, { m: params.m, t: params.t, p: params.p });
  wipe(salt);
  try {
    return await unwrapDek(parsed, ikm, ctx);
  } finally {
    wipe(ikm);
  }
}

export function codePointLength(value: string): number {
  return Array.from(value.normalize("NFKC")).length;
}

function characterClasses(value: string): number {
  let classes = 0;
  if (/\p{Ll}/u.test(value)) classes += 1;
  if (/\p{Lu}/u.test(value)) classes += 1;
  if (/\p{N}/u.test(value)) classes += 1;
  if (/[^\p{L}\p{N}]/u.test(value)) classes += 1;
  return classes;
}

function hasRepeatedRun(value: string): boolean {
  const chars = Array.from(value);
  let run = 1;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === chars[i - 1]) {
      run += 1;
      if (run >= 4) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function hasSequentialRun(value: string): boolean {
  const lower = value.toLowerCase();
  for (const sequence of SEQUENCES) {
    for (let i = 0; i + 4 <= sequence.length; i++) {
      const forward = sequence.slice(i, i + 4);
      const backward = Array.from(forward).reverse().join("");
      if (lower.includes(forward) || lower.includes(backward)) return true;
    }
  }
  return false;
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

function includesToken(haystack: string, token: string): boolean {
  let from = 0;
  while (from <= haystack.length - token.length) {
    const at = haystack.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 || !isWordChar(haystack[at - 1] ?? "");
    const afterAt = at + token.length;
    const after = afterAt === haystack.length || !isWordChar(haystack[afterAt] ?? "");
    if (before && after) return true;
    from = at + 1;
  }
  return false;
}

function userTokens(userInputs: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const raw of userInputs) {
    if (typeof raw !== "string") continue;
    const norm = raw.normalize("NFKC").toLowerCase().trim();
    if (norm.length >= 3) tokens.push(norm);
    const at = norm.indexOf("@");
    if (at > 0) {
      const local = norm.slice(0, at);
      if (local.length >= 3) tokens.push(local);
      const host = norm.slice(at + 1).split(".")[0] ?? "";
      if (host.length >= 3) tokens.push(host);
    }
  }
  return tokens;
}

/**
 * Transparent score, 0..4.
 * Start at 2 once the NFKC password has 12 code points (1 if it has 8..11),
 * plus 1 at 16 code points, plus 1 at 3 character classes and 1 at 4.
 * Then subtract 1 for a 4+ repeated run, a 4+ sequential/keyboard run,
 * or a userInputs token (email, its local part, or a name) on a boundary.
 * A common password, or anything under 12 code points, is capped at 1 ("weak").
 */
export function passwordStrength(password: string, userInputs: readonly string[] = []): PasswordStrength {
  const normalised = password.normalize("NFKC");
  const length = Array.from(normalised).length;
  const classes = characterClasses(normalised);
  const lower = normalised.toLowerCase();
  let score = 0;
  if (length >= 12) score += 2;
  else if (length >= 8) score += 1;
  if (length >= 16) score += 1;
  if (classes >= 3) score += 1;
  if (classes >= 4) score += 1;

  const repeated = hasRepeatedRun(normalised);
  const sequential = hasSequentialRun(normalised);
  const personal = userTokens(userInputs).some((token) => includesToken(lower, token));
  const common = COMMON.has(lower);
  if (repeated) score -= 1;
  if (sequential) score -= 1;
  if (personal) score -= 1;
  if (common) score = Math.min(score, 1);
  if (length < 12) score = Math.min(score, 1);
  score = Math.max(0, Math.min(4, score));

  const issues: string[] = [];
  if (length < 12) issues.push("too-short");
  if (common) issues.push("common");
  if (repeated) issues.push("repeated");
  if (sequential) issues.push("sequential");
  if (personal) issues.push("user-input");
  return { score: score as PasswordStrength["score"], label: LABELS[score], issues };
}

/** Rejects under 12 code points (after NFKC) and anything scored "weak" or below (score < 2). */
export function validateRecoveryPassword(password: string, userInputs?: readonly string[]): PasswordStrength {
  const result = passwordStrength(password, userInputs);
  if (codePointLength(password) < 12 || result.score < 2) throw new PasswordPolicyError(result);
  return result;
}

export type Argon2BenchRow = {
  m: number;
  t: number;
  p: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
};

export type Argon2Bench = {
  /** `process.arch` in Node, otherwise "browser". */
  arch: string;
  /**
   * Left "unknown" in Node: the CPU model needs `node:os`, which this browser
   * module does not import. `scripts/bench-argon2.mjs` fills it in.
   * In a browser this is the user agent.
   */
  cpuModel: string;
  cores: number;
  rows: Argon2BenchRow[];
};

function hostInfo(): { arch: string; cpuModel: string; cores: number } {
  const g = globalThis as {
    process?: { arch?: string };
    navigator?: { hardwareConcurrency?: number; userAgent?: string };
  };
  if (typeof g.process?.arch === "string") {
    return { arch: g.process.arch, cpuModel: "unknown", cores: g.navigator?.hardwareConcurrency ?? 0 };
  }
  return {
    arch: "browser",
    cpuModel: g.navigator?.userAgent ?? "unknown",
    cores: g.navigator?.hardwareConcurrency ?? 0,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timeArgon(memory: number, rounds: number): Promise<number[]> {
  const password = "serpix-argon2-bench";
  const salt = new Uint8Array(16);
  for (let i = 0; i < salt.length; i++) salt[i] = i + 1;
  await deriveArgon2id(password, salt, { m: memory, t: ARGON2_ITERATIONS, p: ARGON2_PARALLELISM });
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    await deriveArgon2id(password, salt, { m: memory, t: ARGON2_ITERATIONS, p: ARGON2_PARALLELISM });
    samples.push(performance.now() - started);
  }
  return samples;
}

/** In-browser (and Node) measurement. One warm-up per memory size, then `rounds` samples (default 7). */
export async function benchmarkArgon2(options?: { rounds?: number }): Promise<Argon2Bench> {
  const rounds = options?.rounds ?? 7;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("invalid benchmark rounds");
  const memories = [ARGON2_MEMORY_KIB, ARGON2_MEMORY_SLOW_KIB];
  const rows: Argon2BenchRow[] = [];
  for (const memory of memories) {
    const samplesMs = await timeArgon(memory, rounds);
    rows.push({
      m: memory,
      t: ARGON2_ITERATIONS,
      p: ARGON2_PARALLELISM,
      medianMs: median(samplesMs),
      minMs: Math.min(...samplesMs),
      maxMs: Math.max(...samplesMs),
      samplesMs,
    });
  }
  return { ...hostInfo(), rows };
}
