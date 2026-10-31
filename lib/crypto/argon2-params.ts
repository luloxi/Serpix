// The only Argon2id costs a password wrap may name. The client creates one of
// these two. Unlock and the server accept nothing else, before any KDF call.

/** 64 MiB. The setup default. */
export const ARGON2_MEMORY_KIB = 65_536;
/** 46 MiB. Used when the 64 MiB derivation takes more than two seconds. */
export const ARGON2_MEMORY_SLOW_KIB = 47_104;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;

/** True only for the 64 MiB and 46 MiB presets (`t` = 3, `p` = 1). */
export function isAllowedArgon2Params(
  params: { m: unknown; t: unknown; p: unknown },
): params is { m: number; t: number; p: number } {
  return (params.m === ARGON2_MEMORY_KIB || params.m === ARGON2_MEMORY_SLOW_KIB)
    && params.t === ARGON2_ITERATIONS
    && params.p === ARGON2_PARALLELISM;
}
