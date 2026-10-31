import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the meeting field is on the contact form and the card, outside brand.css", () => {
  const workspace = readFileSync(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  const field = readFileSync(new URL("../app/event-field.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/contacts.css", import.meta.url), "utf8");
  const brand = readFileSync(new URL("../app/brand.css", import.meta.url), "utf8");
  assert.match(workspace, /Dónde lo conocí \/ evento/);
  assert.match(workspace, /Qué pasó \/ de qué hablamos/);
  assert.match(workspace, /contact-met-note/);
  assert.match(workspace, /\/api\/luma-events/);
  assert.match(field, /role="combobox"/);
  assert.match(field, /role="listbox"/);
  assert.match(field, /role="option"/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /cursor:pointer/);
  assert.match(css, /cursor:not-allowed/);
  assert.equal(brand.includes("event-suggest"), false);
  assert.equal(brand.includes("metEvent"), false);
  assert.ok(layout.indexOf('import "./brand.css"') < layout.indexOf('import "./e2e.css"'));
  assert.ok(layout.indexOf('import "./e2e.css"') < layout.indexOf('import "./contacts.css"'));
});
