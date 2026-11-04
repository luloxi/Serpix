import test from "node:test";
import assert from "node:assert/strict";
import { legacyHostRedirect } from "../lib/legacy-host.ts";

test("legacy hosts 301 to garpen and keep the path and query", () => {
  for (const host of ["erp.lulox.com.ar", "serpix.lulox.com.ar"]) {
    const response = legacyHostRedirect(new Request(`https://${host}/dashboard?x=1&y=2`));
    assert.ok(response);
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "https://garpen.lulox.com.ar/dashboard?x=1&y=2");
  }
  const root = legacyHostRedirect(new Request("https://erp.lulox.com.ar/"));
  assert.equal(root?.headers.get("location"), "https://garpen.lulox.com.ar/");
  assert.equal(legacyHostRedirect(new Request("https://garpen.lulox.com.ar/dashboard")), null);
  assert.equal(legacyHostRedirect(new Request("https://example.com/dashboard?x=1")), null);
});

test("legacy hosts let API calls and POSTs through (Cuentix sync, inbound)", () => {
  assert.equal(legacyHostRedirect(new Request("https://erp.lulox.com.ar/api/integrations/cuentix/events", { method: "POST", body: "{}" })), null);
  assert.equal(legacyHostRedirect(new Request("https://erp.lulox.com.ar/api/auth/session")), null);
  assert.equal(legacyHostRedirect(new Request("https://erp.lulox.com.ar/dashboard", { method: "POST", body: "x" })), null);
});
