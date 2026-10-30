// Run: node --test tests/*.test.mts  (Node 24, native TypeScript stripping)
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, createPublicKey, createVerify, hkdfSync, createDecipheriv, randomBytes } from "node:crypto";
import { encryptPayload, sendPush, vapidAuth, fromB64u } from "../lib/webpush.ts";

const b64u = (b: Buffer) => b.toString("base64url");

// Independent RFC 8291 decryption (node:crypto) for the subscriber side.
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, authSecret: Buffer) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const shared = ua.computeSecret(asPub);
  const prk = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString();
}

test("payload encrypts so an independent RFC 8291 decryptor reads it", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const msg = JSON.stringify({ title: "Nueva solicitud · Prueba Vanellope", body: "ñandú 🚀" });
  const body = await encryptPayload(new TextEncoder().encode(msg), b64u(ua.getPublicKey()), b64u(auth));
  assert.equal(decrypt(Buffer.from(body), ua, auth), msg);
});

test("VAPID JWT verifies with the public key", async () => {
  const k = createECDH("prime256v1"); k.generateKeys();
  const pub = b64u(k.getPublicKey()), priv = b64u(k.getPrivateKey());
  const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", pub, priv, "mailto:a@b.co");
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/.exec(h)!;
  assert.equal(m[4], pub);
  assert.deepEqual(JSON.parse(Buffer.from(m[2], "base64url").toString()).aud, "https://fcm.googleapis.com");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(k.getPublicKey().subarray(1, 33)), y: b64u(k.getPublicKey().subarray(33)) }, format: "jwk" });
  const v = createVerify("SHA256").update(`${m[1]}.${m[2]}`);
  assert.ok(v.verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
  assert.equal(fromB64u(pub).length, 65);
});

test("sendPush posts to the endpoint with the push headers and returns the status", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const v = createECDH("prime256v1"); v.generateKeys();
  let seen: { url: string; init: RequestInit } | null = null;
  const status = await sendPush({ endpoint: "https://push.example.test/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) }, { title: "t" }, { publicKey: b64u(v.getPublicKey()), privateKey: b64u(v.getPrivateKey()), subject: "mailto:a@b.co" }, (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 201 }); }) as unknown as typeof fetch);
  assert.equal(status, 201);
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.ok(h.Authorization.startsWith("vapid t="));
});
