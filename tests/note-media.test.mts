import assert from "node:assert/strict";
import test from "node:test";
import { NOTE_MEDIA_MAX_BYTES, noteMediaPath } from "../lib/note-media.ts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { openDb, user } from "./db-helper.mts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function form(bytes: Buffer = PNG, name = "a.png", type = "image/png") {
  const body = new FormData();
  body.set("file", new File([bytes], name, { type }));
  return body;
}

test("note images are private to the owner and refused for encrypted accounts", async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, "ana");
    user(db, "beto");
    setEnv(d1);
    const post = await import("../app/api/note-media/route.ts");
    const item = await import("../app/api/note-media/[id]/route.ts");

    asUser(null);
    const anon = await call(post, "POST", "http://t.local/api/note-media", { form: form() });
    assert.equal(anon.status, 401);

    asUser("ana");
    db.prepare("UPDATE user SET encryption_mode='e2e' WHERE id='ana'").run();
    const encrypted = await call(post, "POST", "http://t.local/api/note-media", { form: form() });
    assert.equal(encrypted.status, 403);
    assert.deepEqual(encrypted.body, { error: "Cuenta cifrada: usá el modo cifrado de la app." });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM note_media").get() as { n: number }).n, 0);
    db.prepare("UPDATE user SET encryption_mode='server' WHERE id='ana'").run();

    const bad = await call(post, "POST", "http://t.local/api/note-media", { form: form(Buffer.from("<svg></svg>"), "a.svg", "image/svg+xml") });
    assert.equal(bad.status, 415);
    const big = await call(post, "POST", "http://t.local/api/note-media", { form: form(Buffer.alloc(NOTE_MEDIA_MAX_BYTES + 1)) });
    assert.equal(big.status, 413);

    const created = await call(post, "POST", "http://t.local/api/note-media", { form: form() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { id: string; url: string }).id;
    assert.equal((created.body as { url: string }).url, noteMediaPath(id));
    assert.equal(JSON.stringify(created.body).includes(PNG.toString("base64")), false);

    const own = await item.GET(new Request("http://t.local/api/note-media/" + id), { params: Promise.resolve({ id }) });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "image/png");
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    assert.equal(own.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.compare(Buffer.from(await own.arrayBuffer()), PNG), 0);

    asUser("beto");
    const foreign = await call(item, "GET", "http://t.local/api/note-media/" + id, { params: { id } });
    assert.equal(foreign.status, 404);
    const removed = await call(item, "DELETE", "http://t.local/api/note-media/" + id, { params: { id } });
    assert.equal(removed.status, 404);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM note_media WHERE user_id='ana'").get() as { n: number }).n, 1);

    asUser("ana");
    const gone = await call(item, "DELETE", "http://t.local/api/note-media/" + id, { params: { id } });
    assert.equal(gone.status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM note_media").get() as { n: number }).n, 0);
  });
});
