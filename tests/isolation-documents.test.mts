import test from "node:test";
import assert from "node:assert/strict";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { A, B, assert4xx, assertNoA, assertSame, docBody, entryBody, ids, seedWorld, snap } from "./isolation-shared.mts";

const base = "http://t.local";

async function api() {
  return {
    docs: await import("../app/api/documents/route.ts"),
    doc: await import("../app/api/documents/[id]/route.ts"),
    hours: await import("../app/api/documents/time-entries/route.ts"),
    entries: await import("../app/api/time-entries/route.ts"),
    entry: await import("../app/api/time-entries/[id]/route.ts"),
    timer: await import("../app/api/timer/route.ts"),
  };
}

test("B sees only their documents, items and importable hours", async () => {
  await locked(async () => {
    const { d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const list = await call(routes.docs, "GET", base + "/api/documents");
    assert.equal(list.status, 200);
    assertNoA(list.body);
    const items = (list.body as { items: { id: string; totalMinor: number }[] }).items;
    assert.deepEqual(items.map((row) => row.id), [ids.docB]);
    assert.equal(items[0].totalMinor, 100);
    assert.equal((list.body as { issuer: { email: string } }).issuer.email, B + "@test.local");
    const one = await call(routes.doc, "GET", base + "/api/documents/" + ids.docB, { params: { id: ids.docB } });
    assert.equal(one.status, 200);
    assert.deepEqual((one.body as { items: { description: string }[] }).items.map((row) => row.description), ["B-ITEM"]);
    assertNoA(one.body);
    const foreign = await call(routes.doc, "GET", base + "/api/documents/" + ids.docA, { params: { id: ids.docA } });
    assert.equal(foreign.status, 404);
    assertNoA(foreign.body);
    const hours = await call(routes.hours, "GET", base + "/api/documents/time-entries?contactId=" + ids.contactB + "&currency=ARS");
    assert.equal(hours.status, 200);
    const hourIds = (hours.body as { items: { id: string }[] }).items.map((row) => row.id);
    assert.deepEqual(hourIds, [ids.entryB]);
    const foreignHours = await call(routes.hours, "GET", base + "/api/documents/time-entries?contactId=" + ids.contactA + "&currency=ARS");
    assert.deepEqual((foreignHours.body as { items: unknown[] }).items, []);
    const times = await call(routes.entries, "GET", base + "/api/time-entries");
    assert.equal(times.status, 200);
    assertNoA(times.body);
    assert.match(JSON.stringify(times.body), /horas b/);
    const clock = await call(routes.timer, "GET", base + "/api/timer");
    assert.equal(clock.status, 200);
    assert.equal((clock.body as { timer: { startedAt: number } }).timer.startedAt, 222222);
    assertNoA(clock.body);
  });
});

test("edits and deletes of A's documents and hours do not change them", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const before = snap(db);
    const attempts: Promise<{ status: number; body: unknown }>[] = [
      call(routes.doc, "PATCH", base + "/api/documents/" + ids.docA, { params: { id: ids.docA }, json: { action: "save", ...docBody(ids.contactB) } }),
      call(routes.doc, "PATCH", base + "/api/documents/" + ids.docA, { params: { id: ids.docA }, json: { action: "status", status: "void" } }),
      call(routes.doc, "PATCH", base + "/api/documents/" + ids.docA, { params: { id: ids.docA }, json: { action: "pay", accountId: ids.accountB, paidAt: "2026-10-20" } }),
      call(routes.doc, "PATCH", base + "/api/documents/" + ids.docA, { params: { id: ids.docA }, json: { action: "convert" } }),
      call(routes.doc, "DELETE", base + "/api/documents/" + ids.docA, { params: { id: ids.docA } }),
      call(routes.entry, "DELETE", base + "/api/time-entries/" + ids.entryA, { params: { id: ids.entryA } }),
    ];
    for (const pending of attempts) {
      const res = await pending;
      assert4xx(res.status, res.body);
      assertSame(db, before);
    }
    const discarded = await call(routes.timer, "POST", base + "/api/timer", { json: { action: "discard" } });
    assert.equal(discarded.status, 200);
    const aTimer = db.prepare("SELECT started_at AS startedAt FROM timer_state WHERE user_id=?").get(A) as { startedAt: number };
    assert.equal(Number(aTimer.startedAt), 111111);
    assert.equal(db.prepare("SELECT user_id FROM timer_state WHERE user_id=?").get(B), undefined);
  });
});

test("creating a document or hours against A's ids is rejected", async () => {
  await locked(async () => {
    const routes = await api();
    const bodies = [
      docBody(ids.contactA),
      docBody(ids.contactB, ids.entryA),
    ];
    for (const json of bodies) {
      const { db, d1 } = seedWorld();
      setEnv(d1);
      asUser(B);
      const before = snap(db);
      const res = await call(routes.docs, "POST", base + "/api/documents", { json });
      assert4xx(res.status, res.body);
      assertSame(db, before);
    }
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const before = snap(db);
    const hours = await call(routes.entries, "POST", base + "/api/time-entries", { json: entryBody(ids.taskA) });
    assert4xx(hours.status, hours.body);
    assertSame(db, before);
  });
});

test("B's new document and timer save write their own user_id and leave A's timer", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const created = await call(routes.docs, "POST", base + "/api/documents", { json: docBody(ids.contactB) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { id: string }).id;
    const owner = db.prepare("SELECT user_id AS userId FROM document_items WHERE document_id=? AND description=?").get(id, "Linea nueva") as { userId: string };
    assert.equal(owner.userId, B);
    const read = await call(routes.doc, "GET", base + "/api/documents/" + id, { params: { id } });
    assert.equal((read.body as { items: { description: string }[] }).items[0].description, "Linea nueva");
    const saved = await call(routes.entries, "POST", base + "/api/time-entries", { json: entryBody(ids.taskB, true) });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const aTimer = db.prepare("SELECT started_at AS startedAt FROM timer_state WHERE user_id=?").get(A) as { startedAt: number };
    assert.equal(Number(aTimer.startedAt), 111111);
    assert.equal(db.prepare("SELECT user_id FROM timer_state WHERE user_id=?").get(B), undefined);
    const entryId = (saved.body as { id: string }).id;
    const entry = db.prepare("SELECT user_id AS userId FROM time_entries WHERE id=?").get(entryId) as { userId: string };
    assert.equal(entry.userId, B);
  });
});
