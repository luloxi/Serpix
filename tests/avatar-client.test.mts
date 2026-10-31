import test from "node:test";
import assert from "node:assert/strict";
import { avatarUrl, sourcesKey, waNumber } from "../lib/avatar-client.ts";

test("waNumber normalizes Argentine and international phones, rejects junk", () => {
  assert.equal(waNumber("+54 11 5555-1234"), "5491155551234");
  assert.equal(waNumber("+54 9 11 5555-1234"), "5491155551234");
  assert.equal(waNumber("11 5555 1234"), "5491155551234");
  assert.equal(waNumber("011 5555 1234"), "5491155551234");
  assert.equal(waNumber("+34 660 02 15 51"), "34660021551");
  assert.equal(waNumber("+54 "), null);
  assert.equal(waNumber("1234"), null);
  assert.equal(waNumber(undefined), null);
});

test("WhatsApp photo URL goes to unavatar with fallback=false, only with a valid phone", async () => {
  assert.equal(await avatarUrl("whatsapp", "+34 660 02 15 51"), "https://unavatar.io/whatsapp/phone:34660021551?fallback=false");
  assert.equal(await avatarUrl("whatsapp", "+54 "), null);
});

test("sourcesKey includes the phone so a new number retries the lookup", async () => {
  const a = await sourcesKey({ phone: "+54 11 5555-1234" });
  const b = await sourcesKey({ phone: "+54 11 5555-9999" });
  assert.equal(a, "whatsapp:5491155551234");
  assert.notEqual(a, b);
  assert.equal(await sourcesKey({ phone: "+54 " }), "");
});
