// Converts between the crypto vault wrap and the exact JSON the server stores.
// lib/crypto behaviour stays untouched.
import type { PasskeyParams, PasswordParams, Wrap } from "../crypto/wrap.ts";
import type { KeyWrap } from "../e2e-server.ts";

export function toStoredWrap(wrap: Wrap): { type: "password" | "passkey"; wrap: KeyWrap; credentialId: string | null } {
  if (wrap.type === "password") {
    const params = wrap.params as PasswordParams;
    return {
      type: "password",
      credentialId: null,
      wrap: {
        v: 1,
        type: "password",
        salt: wrap.salt,
        n: wrap.n,
        c: wrap.c,
        m: params.m,
        t: params.t,
        p: params.p,
        argonSalt: params.salt,
      },
    };
  }
  const params = wrap.params as PasskeyParams;
  return {
    type: "passkey",
    credentialId: params.credentialId,
    wrap: {
      v: 1,
      type: "passkey",
      salt: wrap.salt,
      n: wrap.n,
      c: wrap.c,
      prfSalt: params.prfSalt,
    },
  };
}

export function fromStoredWrap(id: string, userId: string, stored: KeyWrap, credentialId: string | null): Wrap {
  if (stored.type === "password") {
    return {
      v: 1,
      type: "password",
      userId,
      wrapId: id,
      salt: stored.salt,
      n: stored.n,
      c: stored.c,
      params: { m: stored.m, t: stored.t, p: stored.p, salt: stored.argonSalt },
    };
  }
  return {
    v: 1,
    type: "passkey",
    userId,
    wrapId: id,
    salt: stored.salt,
    n: stored.n,
    c: stored.c,
    params: { prfSalt: stored.prfSalt, credentialId: credentialId ?? "" },
  };
}
