import assert from "node:assert/strict";
import test from "node:test";
import { editorHtmlToStored, markdownToHtml, MAX_NOTE_BODY_CHARS, noteBodyToEditorHtml, NOTE_TOO_BIG, prepareActivityBody, sanitizeNoteHtml } from "../lib/note-html.ts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { openDb, user } from "./db-helper.mts";

const MEDIA = "/api/note-media/123e4567-e89b-42d3-a456-426614174000";
const SAMPLE = `<h1>Hola</h1><p>a <strong>b</strong> <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">link</a></p><img src="${MEDIA}" alt="foto"><ul><li>uno</li></ul>`;

test("rich notes keep formatting and drop scripts, handlers and foreign images", () => {
  const dirty = `<h1 onclick="alert(1)">Hola</h1><p>a <b>b</b> <a href="javascript&#58;alert(1)">x</a> <a href="https://example.com/a">link</a></p><script>alert(1)</script><img src="https://evil.test/a.png" alt="no"><img src="${MEDIA}" alt="foto" onerror="alert(1)"><ul><li>uno</li></ul>`;
  const clean = sanitizeNoteHtml(dirty);
  assert.equal(clean, `<h1>Hola</h1><p>a <strong>b</strong> x <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">link</a></p><img src="${MEDIA}" alt="foto"><ul><li>uno</li></ul>`);
  assert.equal(sanitizeNoteHtml(clean), clean);
  assert.equal(sanitizeNoteHtml(SAMPLE), SAMPLE);
  assert.equal(editorHtmlToStored("<p></p>"), "");
  assert.equal(editorHtmlToStored("<p><br></p>"), "");
});

test("old markdown stays markdown on the server and becomes headings in the editor", () => {
  const source = "# Hola\n\nTexto **fuerte** y *cursiva*.\n\n- a\n- b\n\n[sitio](https://example.com/a)\n[malo](javascript:alert(1))";
  assert.equal(prepareActivityBody("note", source).ok && prepareActivityBody("note", source).value, source);
  assert.equal(noteBodyToEditorHtml(source), '<h1>Hola</h1><p>Texto <strong>fuerte</strong> y <em>cursiva</em>.</p><ul><li>a</li><li>b</li></ul><p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">sitio</a> [malo](javascript:alert(1))</p>');
  assert.equal(markdownToHtml("## Sub\n\n### Bajo"), "<h2>Sub</h2><h3>Bajo</h3>");
  const event = prepareActivityBody("event", "<p>hola</p>");
  assert.equal(event.ok && event.value, "<p>hola</p>");
});

test("a note that is too large is refused instead of cut mid-tag", () => {
  const huge = "<p>" + "a".repeat(MAX_NOTE_BODY_CHARS) + "</p>";
  const refused = prepareActivityBody("note", huge);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, NOTE_TOO_BIG);
});

test("saving a note stores sanitized HTML in the same body column", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    setEnv(d1);
    asUser("ana");
    const routes = await import("../app/api/data/[resource]/route.ts");
    const created = await call(routes, "POST", "http://t.local/api/data/activities", {
      params: { resource: "activities" },
      json: { title: "Nota", kind: "note", occurredAt: "2026-10-01T12:00:00.000Z", body: '<p onclick="x">Hola</p><script>alert(1)</script><img src="https://evil.test/a.png">' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((db.prepare("SELECT body FROM activities WHERE user_id='ana'").get() as { body: string }).body, "<p>Hola</p>");
    const markdown = await call(routes, "POST", "http://t.local/api/data/activities", {
      params: { resource: "activities" },
      json: { title: "Vieja", kind: "note", occurredAt: "2026-10-02T12:00:00.000Z", body: "# Sigue en markdown" },
    });
    assert.equal(markdown.status, 201, JSON.stringify(markdown.body));
    assert.equal((db.prepare("SELECT body FROM activities WHERE title='Vieja'").get() as { body: string }).body, "# Sigue en markdown");
  });
});
