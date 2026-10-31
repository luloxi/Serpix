// Vault setup and unlock. The DEK is generated once. Afterwards only a non-extractable
// CryptoKey is kept. A later wrap (a new passkey) has to open an existing wrap, use the
// raw bytes inside a callback, and wipe them before returning.

import { base64UrlToBytes, wipe } from "./bytes.ts";
import { cacheDek, clearDeviceCache } from "./device-cache.ts";
import { generateDekBytes, importDek, vault, type Vault } from "./dek.ts";
import type { ByteRng } from "./envelope.ts";
import { buildRecoveryKit, type RecoveryKit } from "./kit.ts";
import {
  createPasskeyWrap,
  getPrfOutput,
  openPasskeyWrap,
  PrfUnsupportedError,
  registerPasskey,
  type CredentialsLike,
} from "./passkey.ts";
import { createPasswordWrap, openPasswordWrap, validateRecoveryPassword, type ElapsedTimer } from "./password.ts";
import { assertWrap, WrapError, type Wrap } from "./wrap.ts";

export type { Vault };
export { vault };

export type VaultWraps = {
  password: Wrap;
  passkey?: Wrap;
};

export type CreateVaultResult = {
  wraps: VaultWraps;
  kit: RecoveryKit;
  dekKey: CryptoKey;
};

export type PasskeyDeps = {
  userName: string;
  rpId: string;
  challenge: Uint8Array;
  credentials: CredentialsLike;
};

export async function createVault(input: {
  userId: string;
  email: string;
  password: string;
  passkey?: PasskeyDeps;
  wrapIds: { password: string; passkey?: string };
  deps?: {
    now?: () => number;
    timer?: ElapsedTimer;
    rng?: ByteRng;
    idb?: IDBFactory;
    /** Default false. The device cache stays empty unless this is exactly true. */
    remember?: boolean;
    appUrl?: string;
    createdAt?: string | Date;
    vault?: Vault;
  };
}): Promise<CreateVaultResult> {
  const deps = input.deps ?? {};
  if (!deps.appUrl) throw new Error("appUrl is required");
  validateRecoveryPassword(input.password, [input.email]);
  if (input.passkey && !input.wrapIds.passkey) throw new Error("wrapIds.passkey is required when registering a passkey");
  const dekRaw = generateDekBytes();
  try {
    const passwordWrap = await createPasswordWrap(dekRaw, input.password, {
      userId: input.userId,
      wrapId: input.wrapIds.password,
      now: deps.now,
      timer: deps.timer,
      rng: deps.rng,
    });
    let passkeyWrap: Wrap | undefined;
    if (input.passkey) {
      let registered: { credentialId: Uint8Array; prfSalt: Uint8Array; prfOutput: Uint8Array } | null = null;
      try {
        registered = await registerPasskey({
          userId: input.userId,
          userName: input.passkey.userName,
          rpId: input.passkey.rpId,
          challenge: input.passkey.challenge,
          credentials: input.passkey.credentials,
          rng: deps.rng,
        });
        passkeyWrap = await createPasskeyWrap(dekRaw, registered.prfOutput, {
          userId: input.userId,
          wrapId: input.wrapIds.passkey as string,
          credentialId: registered.credentialId,
          prfSalt: registered.prfSalt,
          rng: deps.rng,
        });
      } catch (err) {
        if (!(err instanceof PrfUnsupportedError)) throw err;
        passkeyWrap = undefined;
      } finally {
        if (registered) {
          wipe(registered.prfOutput);
          wipe(registered.prfSalt);
          wipe(registered.credentialId);
        }
      }
    }
    if (deps.remember === true) {
      await cacheDek({
        dekRaw,
        userId: input.userId,
        remember: true,
        idb: deps.idb,
      });
    }
    const dekKey = await importDek(dekRaw);
    const holder = deps.vault ?? vault;
    holder.set(dekKey);
    const kit = buildRecoveryKit({
      email: input.email,
      createdAt: deps.createdAt ?? new Date(),
      passwordWrap,
      appUrl: deps.appUrl,
    });
    const wraps: VaultWraps = passkeyWrap ? { password: passwordWrap, passkey: passkeyWrap } : { password: passwordWrap };
    return { wraps, kit, dekKey };
  } finally {
    wipe(dekRaw);
  }
}

export async function unlockPasswordToRaw<T>(
  wrap: Wrap,
  password: string,
  ctx: { userId: string; wrapId: string },
  withRaw: (dekRaw: Uint8Array) => Promise<T> | T,
): Promise<T> {
  const raw = await openPasswordWrap(wrap, password, ctx);
  try {
    return await withRaw(raw);
  } finally {
    wipe(raw);
  }
}

export async function unlockPasskeyToRaw<T>(
  wrap: Wrap,
  ctx: { userId: string; wrapId: string },
  deps: { credentials: CredentialsLike; rpId: string; challenge: Uint8Array },
  withRaw: (dekRaw: Uint8Array) => Promise<T> | T,
): Promise<T> {
  const parsed = assertWrap(wrap);
  if (parsed.type !== "passkey" || !parsed.params || !("prfSalt" in parsed.params)) {
    throw new WrapError("not a passkey wrap");
  }
  const prfOutput = await getPrfOutput({
    credentialId: base64UrlToBytes(parsed.params.credentialId),
    prfSalt: base64UrlToBytes(parsed.params.prfSalt),
    rpId: deps.rpId,
    challenge: deps.challenge,
    credentials: deps.credentials,
  });
  try {
    const raw = await openPasskeyWrap(parsed, prfOutput, ctx);
    try {
      return await withRaw(raw);
    } finally {
      wipe(raw);
    }
  } finally {
    wipe(prfOutput);
  }
}

export async function unlockWithPassword(
  wraps: { password: Wrap },
  password: string,
  ctx: { userId: string; wrapId: string },
  deps?: { vault?: Vault },
): Promise<CryptoKey> {
  return unlockPasswordToRaw(wraps.password, password, ctx, async (raw) => {
    const key = await importDek(raw);
    (deps?.vault ?? vault).set(key);
    return key;
  });
}

export async function unlockWithPasskey(
  wraps: { passkey?: Wrap },
  ctx: { userId: string; wrapId: string },
  deps: { credentials: CredentialsLike; rpId: string; challenge: Uint8Array; vault?: Vault },
): Promise<CryptoKey> {
  if (!wraps.passkey) throw new Error("no passkey wrap");
  return unlockPasskeyToRaw(wraps.passkey, ctx, deps, async (raw) => {
    const key = await importDek(raw);
    (deps.vault ?? vault).set(key);
    return key;
  });
}

/**
 * The in-memory CryptoKey cannot be exported, so a new passkey wrap re-opens the
 * password wrap and wipes the raw DEK before returning.
 */
export async function addPasskeyWrap(input: {
  wraps: { password: Wrap };
  password: string;
  ctx: { userId: string; wrapId: string };
  passkeyWrapId: string;
  userName: string;
  rpId: string;
  challenge: Uint8Array;
  credentials: CredentialsLike;
  rng?: ByteRng;
}): Promise<Wrap> {
  return unlockPasswordToRaw(input.wraps.password, input.password, input.ctx, async (raw) => {
    const registered = await registerPasskey({
      userId: input.ctx.userId,
      userName: input.userName,
      rpId: input.rpId,
      challenge: input.challenge,
      credentials: input.credentials,
      rng: input.rng,
    });
    try {
      return await createPasskeyWrap(raw, registered.prfOutput, {
        userId: input.ctx.userId,
        wrapId: input.passkeyWrapId,
        credentialId: registered.credentialId,
        prfSalt: registered.prfSalt,
        rng: input.rng,
      });
    } finally {
      wipe(registered.prfOutput);
      wipe(registered.prfSalt);
      wipe(registered.credentialId);
    }
  });
}

/** Drop the in-memory DEK and the device cache. `pagehide` does not do this. */
export async function signOut(options?: { idb?: IDBFactory; vault?: Vault; blockedTimeoutMs?: number; openTimeoutMs?: number }): Promise<void> {
  (options?.vault ?? vault).clear();
  await clearDeviceCache({ idb: options?.idb, blockedTimeoutMs: options?.blockedTimeoutMs, openTimeoutMs: options?.openTimeoutMs });
}
