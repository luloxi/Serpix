// Passkey PRF with the fake authenticator. No Argon2.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { wipe } from "../lib/crypto/bytes.ts";
import { DecryptError } from "../lib/crypto/envelope.ts";
import {
  PrfUnsupportedError,
  createPasskeyWrap,
  getPrfOutput,
  openPasskeyWrap,
  registerPasskey,
  type CredentialsLike,
} from "../lib/crypto/passkey.ts";
import { fakeAuthenticator, type FakeMode } from "./helpers/fake-authenticator.ts";
import { hexToBytes } from "./helpers/codec.ts";

const secret = hexToBytes("1111111111111111111111111111111111111111111111111111111111111111");
const challenge = new Uint8Array(32).fill(9);
const rpId = "serpix.example";

function counting(mode: FakeMode): { credentials: CredentialsLike; counts: () => { create: number; get: number } } {
  const inner = fakeAuthenticator(secret, mode);
  const counts = { create: 0, get: 0 };
  return {
    counts: () => ({ ...counts }),
    credentials: {
      create: async (options) => {
        counts.create += 1;
        return inner.create(options);
      },
      get: async (options) => {
        counts.get += 1;
        return inner.get(options);
      },
    },
  };
}

function hmac(salt: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(Buffer.concat([Buffer.from("WebAuthn PRF\0"), Buffer.from(salt)])).digest();
}

test("a PRF result on create is accepted and matches HMAC-SHA-256", async () => {
  const fake = counting("prf");
  const registered = await registerPasskey({
    userId: "user-1",
    userName: "ada@example.com",
    rpId,
    challenge,
    credentials: fake.credentials,
  });
  assert.deepEqual(fake.counts(), { create: 1, get: 0 });
  assert.equal(registered.prfSalt.byteLength, 32);
  assert.equal(registered.credentialId.byteLength, 16);
  assert.equal(Buffer.from(registered.prfOutput).toString("hex"), hmac(registered.prfSalt).toString("hex"));

  const again = await getPrfOutput({
    credentialId: registered.credentialId,
    prfSalt: registered.prfSalt,
    rpId,
    challenge: new Uint8Array(32).fill(3),
    credentials: fake.credentials,
  });
  assert.equal(Buffer.from(again).toString("hex"), Buffer.from(registered.prfOutput).toString("hex"));
  assert.equal(fake.counts().get, 1);

  const dek = hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
  const wrap = await createPasskeyWrap(dek, registered.prfOutput, {
    userId: "user-1",
    wrapId: "wrap-pk",
    credentialId: registered.credentialId,
    prfSalt: registered.prfSalt,
  });
  assert.equal(wrap.type, "passkey");
  const opened = await openPasskeyWrap(wrap, again, { userId: "user-1", wrapId: "wrap-pk" });
  assert.equal(Buffer.from(opened).toString("hex"), Buffer.from(dek).toString("hex"));
  await assert.rejects(
    () => openPasskeyWrap(wrap, secret, { userId: "user-1", wrapId: "wrap-pk" }),
    DecryptError,
  );
  await assert.rejects(
    () => openPasskeyWrap(wrap, registered.prfOutput, { userId: "user-2", wrapId: "wrap-pk" }),
    DecryptError,
  );
  wipe(opened);
  wipe(again);
  wipe(registered.prfOutput);
  wipe(registered.prfSalt);
  wipe(registered.credentialId);
});

test("create that only sets prf.enabled is followed by get", async () => {
  const fake = counting("prf-on-get");
  const registered = await registerPasskey({
    userId: "user-1",
    userName: "ada@example.com",
    rpId,
    challenge,
    credentials: fake.credentials,
  });
  assert.deepEqual(fake.counts(), { create: 1, get: 1 });
  assert.equal(Buffer.from(registered.prfOutput).toString("hex"), hmac(registered.prfSalt).toString("hex"));
  wipe(registered.prfOutput);
  wipe(registered.prfSalt);
  wipe(registered.credentialId);
});

test("an authenticator without PRF throws PrfUnsupportedError", async () => {
  const fake = counting("none");
  await assert.rejects(
    () => registerPasskey({
      userId: "user-1",
      userName: "ada@example.com",
      rpId,
      challenge,
      credentials: fake.credentials,
    }),
    PrfUnsupportedError,
  );
  assert.deepEqual(fake.counts(), { create: 1, get: 0 });
});

test("a second fake with the same secret does not see the credential", async () => {
  const first = fakeAuthenticator(secret, "prf");
  const registered = await registerPasskey({
    userId: "user-1",
    userName: "ada@example.com",
    rpId,
    challenge,
    credentials: first,
  });
  const second = fakeAuthenticator(secret, "prf");
  await assert.rejects(
    () => getPrfOutput({
      credentialId: registered.credentialId,
      prfSalt: registered.prfSalt,
      rpId,
      challenge,
      credentials: second,
    }),
    PrfUnsupportedError,
  );
  wipe(registered.prfOutput);
  wipe(registered.prfSalt);
  wipe(registered.credentialId);
});
