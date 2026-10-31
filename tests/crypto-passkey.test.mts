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

function counting(mode: FakeMode): {
  credentials: CredentialsLike;
  counts: () => { create: number; get: number };
  creation: () => CredentialCreationOptions | null;
  requests: () => CredentialRequestOptions[];
} {
  const inner = fakeAuthenticator(secret, mode);
  const counts = { create: 0, get: 0 };
  let creation: CredentialCreationOptions | null = null;
  const requests: CredentialRequestOptions[] = [];
  return {
    counts: () => ({ ...counts }),
    creation: () => creation,
    requests: () => requests,
    credentials: {
      create: async (options) => {
        counts.create += 1;
        creation = options;
        return inner.create(options);
      },
      get: async (options) => {
        counts.get += 1;
        requests.push(options);
        return inner.get(options);
      },
    },
  };
}

function assertUserVerification(creation: CredentialCreationOptions | null, requests: CredentialRequestOptions[]): void {
  if (creation) {
    assert.equal(creation.publicKey?.authenticatorSelection?.userVerification, "required");
    assert.equal(creation.publicKey?.authenticatorSelection?.residentKey, "preferred");
  }
  for (const request of requests) {
    assert.equal(request.publicKey?.userVerification, "required");
  }
}

function ceremony(rawId: ArrayBuffer | null, first: BufferSource | null, enabled = false) {
  const prf = first
    ? { enabled: true, results: { first } }
    : enabled
      ? { enabled: true }
      : undefined;
  return {
    type: "public-key" as const,
    ...(rawId ? { rawId } : {}),
    response: { clientDataJSON: new ArrayBuffer(0) },
    getClientExtensionResults() {
      return prf ? { prf } : {};
    },
  };
}

function registerWith(credentials: CredentialsLike) {
  return registerPasskey({
    userId: "user-1",
    userName: "ada@example.com",
    rpId,
    challenge,
    credentials,
  });
}

function tap(impl: CredentialsLike) {
  let creation: CredentialCreationOptions | null = null;
  const requests: CredentialRequestOptions[] = [];
  return {
    creation: () => creation,
    requests,
    credentials: {
      async create(options: CredentialCreationOptions) {
        creation = options;
        return impl.create(options);
      },
      async get(options: CredentialRequestOptions) {
        requests.push(options);
        return impl.get(options);
      },
    } satisfies CredentialsLike,
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
  assertUserVerification(fake.creation(), []);
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
  assertUserVerification(null, fake.requests());

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
  assertUserVerification(fake.creation(), fake.requests());
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
  assertUserVerification(fake.creation(), fake.requests());
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

test("a 32-byte all-zero PRF is rejected on create, the follow-up get, and getPrfOutput", async () => {
  const createdId = new Uint8Array(16).fill(4);
  const createZero = new Uint8Array(32);
  let followGets = 0;
  const direct = tap({
    async create() {
      return ceremony(createdId.buffer, createZero);
    },
    async get() {
      followGets += 1;
      return ceremony(createdId.slice().buffer, new Uint8Array(32).fill(9));
    },
  });
  await assert.rejects(() => registerWith(direct.credentials), PrfUnsupportedError);
  assert.equal(followGets, 0);
  assert.deepEqual(createZero, new Uint8Array(32));
  assertUserVerification(direct.creation(), direct.requests);

  const followId = new Uint8Array(16).fill(5);
  const followZero = new Uint8Array(32);
  const follow = tap({
    async create() {
      return ceremony(followId.buffer, null, true);
    },
    async get() {
      return ceremony(followId.slice().buffer, followZero.buffer);
    },
  });
  await assert.rejects(() => registerWith(follow.credentials), PrfUnsupportedError);
  assert.equal(follow.requests.length, 1);
  assert.deepEqual(followZero, new Uint8Array(32));
  assertUserVerification(follow.creation(), follow.requests);

  const unlockId = new Uint8Array(16).fill(6);
  const unlockZero = new Uint8Array(32);
  const salt = new Uint8Array(32).fill(2);
  const unlock = tap({
    async create() {
      return null;
    },
    async get() {
      return ceremony(unlockId.slice().buffer, unlockZero);
    },
  });
  await assert.rejects(
    () => getPrfOutput({
      credentialId: unlockId,
      prfSalt: salt,
      rpId,
      challenge,
      credentials: unlock.credentials,
    }),
    PrfUnsupportedError,
  );
  assert.deepEqual(unlockZero, new Uint8Array(32));
  assert.deepEqual(unlockId, new Uint8Array(16).fill(6));
  assert.equal(salt[0], 2);
  assertUserVerification(null, unlock.requests);

  const almost = new Uint8Array(32);
  almost[31] = 1;
  const accepted = await getPrfOutput({
    credentialId: unlockId,
    prfSalt: salt,
    rpId,
    challenge,
    credentials: {
      async create() {
        return null;
      },
      async get() {
        return ceremony(unlockId.slice().buffer, almost.buffer);
      },
    },
  });
  assert.equal(accepted[31], 1);
  assert.equal(accepted[0], 0);
  wipe(accepted);
});

test("a get result whose rawId is not the requested credential is rejected and the PRF is wiped", async () => {
  const createdId = new Uint8Array(16).fill(1);
  const otherId = new Uint8Array(16).fill(2);
  const followPrf = new Uint8Array(32).fill(8);
  const follow = tap({
    async create() {
      return ceremony(createdId.buffer, null, true);
    },
    async get() {
      return ceremony(otherId.buffer, followPrf.buffer);
    },
  });
  await assert.rejects(() => registerWith(follow.credentials), PrfUnsupportedError);
  assert.deepEqual(followPrf, new Uint8Array(32));
  assert.deepEqual(createdId, new Uint8Array(16).fill(1));
  assertUserVerification(follow.creation(), follow.requests);

  const longerId = new Uint8Array(17);
  longerId.set(createdId);
  const longerPrf = new Uint8Array(32).fill(3);
  const longer = tap({
    async create() {
      return ceremony(createdId.slice().buffer, null, true);
    },
    async get() {
      return ceremony(longerId.buffer, longerPrf.buffer);
    },
  });
  await assert.rejects(() => registerWith(longer.credentials), PrfUnsupportedError);
  assert.deepEqual(longerPrf, new Uint8Array(32));

  const requested = new Uint8Array(16).fill(7);
  const returned = new Uint8Array(16).fill(8);
  const unlockPrf = new Uint8Array(32).fill(9);
  const salt = new Uint8Array(32).fill(4);
  const unlock = tap({
    async create() {
      return null;
    },
    async get() {
      return ceremony(returned.buffer, unlockPrf.buffer);
    },
  });
  await assert.rejects(
    () => getPrfOutput({
      credentialId: requested,
      prfSalt: salt,
      rpId,
      challenge,
      credentials: unlock.credentials,
    }),
    PrfUnsupportedError,
  );
  assert.deepEqual(unlockPrf, new Uint8Array(32));
  assert.deepEqual(requested, new Uint8Array(16).fill(7));
  assert.equal(salt[0], 4);
  assertUserVerification(null, unlock.requests);

  const missingPrf = new Uint8Array(32).fill(5);
  await assert.rejects(
    () => getPrfOutput({
      credentialId: requested,
      prfSalt: salt,
      rpId,
      challenge,
      credentials: {
        async create() {
          return null;
        },
        async get() {
          return ceremony(null, missingPrf.buffer);
        },
      },
    }),
    PrfUnsupportedError,
  );
  assert.deepEqual(missingPrf, new Uint8Array(32));
});
