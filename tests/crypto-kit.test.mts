// Recovery kit text. The wrap is built with HKDF, not Argon2.

import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64Url } from "../lib/crypto/bytes.ts";
import { KitError, buildRecoveryKit, parseRecoveryKit } from "../lib/crypto/kit.ts";
import { assertWrap, wrapDek } from "../lib/crypto/wrap.ts";
import { hexToBytes, sequentialRng } from "./helpers/codec.ts";

const dek = hexToBytes("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5");
const ikm = hexToBytes("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
const password = "frase-secreta-que-no-va";

async function passwordWrap() {
  return wrapDek(dek, ikm, {
    type: "password",
    userId: "user-1",
    wrapId: "wrap-1",
    rng: sequentialRng(0x10),
    params: {
      m: 65536,
      t: 3,
      p: 1,
      salt: bytesToBase64Url(new Uint8Array(16).fill(7)),
    },
  });
}

test("the kit is Spanish, dated in UTC, and holds only the password wrap", async () => {
  const wrap = await passwordWrap();
  const kit = buildRecoveryKit({
    email: "ada&co@example.com",
    createdAt: "2026-10-31T23:30:00.000Z",
    passwordWrap: wrap,
    appUrl: "https://serpix.example",
  });
  assert.equal(kit.filename, "serpix-kit-recuperacion-2026-10-31.txt");
  assert.match(kit.text, /31 de octubre de 2026/);
  assert.match(kit.text, /ada&co@example.com/);
  assert.match(kit.text, /https:\/\/serpix\.example/);
  assert.match(kit.text, /passkey/);
  assert.match(kit.text, /contraseña/);
  assert.match(kit.text, /para siempre/);
  assert.match(kit.text, /administrador/);
  assert.equal(kit.text.includes(password), false);
  assert.equal(kit.text.includes(Buffer.from(dek).toString("hex")), false);
  assert.equal(kit.text.includes(Buffer.from(dek).toString("base64url")), false);
  assert.equal(kit.html.includes(password), false);
  assert.equal(kit.html.includes(Buffer.from(dek).toString("base64url")), false);
  assert.match(kit.html, /ada&amp;co@example\.com/);
  assert.match(kit.html, /class="warn"/);
  assert.match(kit.html, /para siempre/);
  assert.match(kit.html, /administrador/);
  assert.equal(kit.html.includes("&quot;"), true);

  assert.deepEqual(parseRecoveryKit(kit.text), assertWrap(wrap));
  assert.throws(() => parseRecoveryKit(kit.html), KitError);
  assert.throws(() => parseRecoveryKit("sin marcadores"), KitError);

  const nextDay = buildRecoveryKit({
    email: "ada@example.com",
    createdAt: new Date("2026-11-01T00:30:00.000Z"),
    passwordWrap: wrap,
    appUrl: "https://serpix.example",
  });
  assert.equal(nextDay.filename, "serpix-kit-recuperacion-2026-11-01.txt");
  assert.match(nextDay.text, /1 de noviembre de 2026/);
});

test("the kit refuses a wrap that is not a password wrap", async () => {
  const wrap = await wrapDek(dek, ikm, {
    type: "backup",
    userId: "user-1",
    wrapId: "wrap-1",
    rng: sequentialRng(0x40),
  });
  assert.throws(() => buildRecoveryKit({
    email: "ada@example.com",
    createdAt: "2026-10-31T00:00:00.000Z",
    passwordWrap: wrap,
    appUrl: "https://serpix.example",
  }), KitError);
  const kitWrap = await passwordWrap();
  assert.throws(() => buildRecoveryKit({
    email: "",
    createdAt: "not-a-date",
    passwordWrap: kitWrap,
    appUrl: "https://serpix.example",
  }), KitError);
});
