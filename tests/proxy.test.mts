import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyProxyHeaders, buildCsp, newNonce } from "../lib/csp.ts";

function apply(pathname: string, init?: HeadersInit, isDev = false) {
  const nonce = newNonce();
  const headers = new Headers(init);
  applyProxyHeaders(headers, { csp: buildCsp({ nonce, isDev }), pathname });
  return { nonce, headers };
}

test("an HTML response is no-store, carries the CSP, and a new nonce each request", () => {
  const first = apply("/");
  const second = apply("/dashboard");
  const dev = apply("/login", undefined, true);

  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(second.headers.get("cache-control"), "no-store");
  assert.equal(dev.headers.get("cache-control"), "no-store");
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.headers.get("content-security-policy"), second.headers.get("content-security-policy"));

  const csp = first.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes(`'nonce-${first.nonce}'`));
  assert.ok(csp.includes("script-src"));
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.ok((dev.headers.get("content-security-policy") ?? "").includes("'unsafe-eval'"));
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(first.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("a Cache-Control already on the response is not replaced", () => {
  const avatar = "private, max-age=31536000, immutable";
  const html = apply("/", { "Cache-Control": avatar });
  assert.equal(html.headers.get("cache-control"), avatar);
  assert.ok((html.headers.get("content-security-policy") ?? "").includes(`'nonce-${html.nonce}'`));

  const receipt = apply("/api/receipts/1", { "Cache-Control": "private, no-store" });
  assert.equal(receipt.headers.get("cache-control"), "private, no-store");

  const image = apply("/api/avatar/c1", { "Cache-Control": avatar });
  assert.equal(image.headers.get("cache-control"), avatar);
});

test("API routes are not given a proxy Cache-Control", () => {
  const bare = apply("/api/avatar/c1");
  assert.equal(bare.headers.get("cache-control"), null);
  assert.ok((bare.headers.get("content-security-policy") ?? "").includes("script-src"));
  assert.equal(bare.headers.get("x-content-type-options"), "nosniff");

  const root = apply("/api");
  assert.equal(root.headers.get("cache-control"), null);

  const near = apply("/apiculture");
  assert.equal(near.headers.get("cache-control"), "no-store");
});

test("static asset headers stay cacheable", () => {
  const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(file, /\/_next\/static\/\*\n {2}Cache-Control: public,max-age=31536000,immutable/);
  assert.match(file, /\/icons\/\*\n {2}Cache-Control: public,max-age=31536000,immutable/);
  assert.equal(file.includes("no-store"), false);
});
