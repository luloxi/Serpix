import test from "node:test";
import assert from "node:assert/strict";
import { CSP_CONNECT_HOSTS, CSP_IMG_HOSTS, SECURITY_HEADERS, buildCsp, newNonce } from "../lib/csp.ts";

const NONCE = "N0nce+Val/id=";
const REQUIRED = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "connect-src",
  "font-src",
  "worker-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "upgrade-insecure-requests",
];

function parse(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    const name = bits[0];
    if (!name) continue;
    map.set(name, bits.slice(1));
  }
  return map;
}

function hosts(tokens: string[]): string[] {
  return tokens.filter((token) => token.startsWith("https://") || token.startsWith("http://"));
}

test("production policy has every directive, the nonce, and no eval or wildcard", () => {
  const csp = buildCsp({ nonce: NONCE, isDev: false });
  const directives = parse(csp);
  assert.deepEqual([...directives.keys()], REQUIRED);
  assert.equal(csp.includes("*"), false);
  assert.equal(csp.includes("\n"), false);
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes("ws:"), false);

  const script = directives.get("script-src") ?? [];
  assert.ok(script.includes(`'nonce-${NONCE}'`));
  assert.ok(script.includes("'wasm-unsafe-eval'"));
  assert.ok(script.includes("'strict-dynamic'"));
  assert.ok(script.includes("'self'"));
  for (const [name, tokens] of directives) {
    if (name === "script-src") continue;
    assert.equal(tokens.includes("'wasm-unsafe-eval'"), false, name);
    assert.equal(tokens.includes("'unsafe-eval'"), false, name);
    assert.equal(tokens.includes("'strict-dynamic'"), false, name);
  }

  assert.deepEqual(directives.get("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.equal((directives.get("style-src") ?? []).some((token) => token.startsWith("'nonce-")), false);
  assert.deepEqual(directives.get("img-src")?.slice(0, 3), ["'self'", "data:", "blob:"]);
  assert.deepEqual(hosts(directives.get("img-src") ?? []), [...CSP_IMG_HOSTS]);
  assert.deepEqual(hosts(directives.get("connect-src") ?? []), [...CSP_CONNECT_HOSTS]);
  assert.deepEqual(directives.get("font-src"), ["'self'"]);
  assert.deepEqual(directives.get("worker-src"), ["'self'"]);
  assert.deepEqual(directives.get("manifest-src"), ["'self'"]);
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'self'"]);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("upgrade-insecure-requests"), []);
});

test("the allow-list is exactly the hosts the client uses", () => {
  assert.deepEqual([...CSP_IMG_HOSTS], [
    "https://lh3.googleusercontent.com",
    "https://lh4.googleusercontent.com",
    "https://lh5.googleusercontent.com",
    "https://lh6.googleusercontent.com",
  ]);
  assert.deepEqual([...CSP_CONNECT_HOSTS], ["https://gravatar.com", "https://unavatar.io"]);
  const csp = buildCsp({ nonce: NONCE, isDev: false });
  const found = [...csp.matchAll(/https:\/\/[^\s;]+/g)].map((match) => match[0]);
  assert.deepEqual(found, [...CSP_IMG_HOSTS, ...CSP_CONNECT_HOSTS]);
});

test("dev adds unsafe-eval and ws: and production does not", () => {
  const dev = parse(buildCsp({ nonce: NONCE, isDev: true }));
  const prod = buildCsp({ nonce: NONCE, isDev: false });
  assert.equal(dev.get("script-src")?.includes("'unsafe-eval'"), true);
  assert.equal(dev.get("connect-src")?.includes("ws:"), true);
  assert.equal(dev.get("script-src")?.includes("'wasm-unsafe-eval'"), true);
  for (const [name, tokens] of dev) {
    if (name !== "script-src") assert.equal(tokens.includes("'unsafe-eval'"), false, name);
    if (name !== "connect-src") assert.equal(tokens.includes("ws:"), false, name);
  }
  assert.equal(prod.includes("'unsafe-eval'"), false);
  assert.equal(prod.includes("ws:"), false);
  assert.equal(buildCsp({ nonce: NONCE, isDev: true }).includes("*"), false);
});

test("a nonce outside the Next.js parser alphabet is rejected", () => {
  assert.throws(() => buildCsp({ nonce: "has space", isDev: false }), /Invalid CSP nonce/);
  assert.throws(() => buildCsp({ nonce: "a;default-src", isDev: false }), /Invalid CSP nonce/);
  assert.throws(() => buildCsp({ nonce: "", isDev: false }), /Invalid CSP nonce/);
  const nonce = newNonce();
  assert.match(nonce, /^[A-Za-z0-9+/_-]+={0,2}$/);
  assert.notEqual(newNonce(), nonce);
  assert.match(buildCsp({ nonce, isDev: false }), new RegExp(`'nonce-${nonce.replace(/\+/g, "\\+")}'`));
});

test("document security headers stay minimal and keep WebAuthn on this origin", () => {
  assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(SECURITY_HEADERS["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(SECURITY_HEADERS["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  assert.equal(
    SECURITY_HEADERS["Permissions-Policy"],
    "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
});
