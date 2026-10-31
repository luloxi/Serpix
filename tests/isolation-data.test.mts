import test from "node:test";
import assert from "node:assert/strict";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { A, B, assert4xx, assertNoA, assertSame, ids, seedWorld, snap, txBody } from "./isolation-shared.mts";

const RESOURCES = ["contacts", "projects", "tasks", "accounts", "transactions", "activities"] as const;
const base = "http://t.local";

async function api() {
  return {
    list: await import("../app/api/data/[resource]/route.ts"),
    one: await import("../app/api/data/[resource]/[id]/route.ts"),
    finance: await import("../app/api/finance/totals/route.ts"),
    avatar: await import("../app/api/avatar/[id]/route.ts"),
    admin: await import("../app/api/admin/users/route.ts"),
    adminUser: await import("../app/api/admin/users/[userId]/route.ts"),
  };
}

const patchBody: Record<string, unknown> = {
  contacts: { name: "Hackeado" },
  projects: { name: "Hackeado" },
  tasks: { title: "Hackeado" },
  accounts: { name: "Hackeado" },
  activities: { title: "Hackeado", kind: "note", contactIds: [] },
  transactions: txBody(ids.accountB),
};
const ownId: Record<string, string> = {
  contacts: ids.contactA, projects: ids.projectA, tasks: ids.taskA, accounts: ids.accountA, activities: ids.activityA, transactions: ids.txA,
};

test("B's lists and totals never include A's rows", async () => {
  await locked(async () => {
    const { d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    for (const resource of RESOURCES) {
      const res = await call(routes.list, "GET", base + "/api/data/" + resource, { params: { resource } });
      assert.equal(res.status, 200, resource);
      assertNoA(res.body);
    }
    const contacts = await call(routes.list, "GET", base + "/api/data/contacts", { params: { resource: "contacts" } });
    assert.match(JSON.stringify(contacts.body), /B-CONTACT/);
    const activities = await call(routes.list, "GET", base + "/api/data/activities", { params: { resource: "activities" } });
    const mine = (activities.body as { items: { id: string; contactIds: string; contactNames: string }[] }).items.find((row) => row.id === ids.activityB);
    assert.equal(mine?.contactIds, ids.contactB);
    assert.equal(mine?.contactNames, "B-CONTACT");
    const tasks = await call(routes.list, "GET", base + "/api/data/tasks", { params: { resource: "tasks" } });
    assert.match(JSON.stringify(tasks.body), /B-TASK/);
    assert.match(JSON.stringify(tasks.body), /B-PROJECT/);
    const txs = await call(routes.list, "GET", base + "/api/data/transactions", { params: { resource: "transactions" } });
    const txItems = (txs.body as { items: { id: string; receiptId: string }[] }).items;
    assert.deepEqual(txItems.map((row) => row.id), [ids.txB]);
    assert.equal(txItems[0].receiptId, ids.receiptB);
    const totals = await call(routes.finance, "GET", base + "/api/finance/totals");
    assert.equal(totals.status, 200);
    const body = totals.body as { ARS: { expenseMinor: number }; transactionCount: number };
    assert.equal(body.ARS.expenseMinor, 100);
    assert.equal(body.transactionCount, 1);
    assertNoA(totals.body);
  });
});

test("B cannot edit or delete A's workspace rows", async () => {
  const routes = await api();
  for (const resource of RESOURCES) {
    await locked(async () => {
      const { db, d1 } = seedWorld();
      setEnv(d1);
      asUser(B);
      const before = snap(db);
      const patched = await call(routes.one, "PATCH", base + "/api/data/" + resource + "/" + ownId[resource], { params: { resource, id: ownId[resource] }, json: patchBody[resource] });
      assert4xx(patched.status, patched.body);
      assertSame(db, before);
      const removed = await call(routes.one, "DELETE", base + "/api/data/" + resource + "/" + ownId[resource], { params: { resource, id: ownId[resource] } });
      assert4xx(removed.status, removed.body);
      assertSame(db, before);
    });
  }
});

test("creates that point at A's ids are rejected and link nothing", async () => {
  await locked(async () => {
    const routes = await api();
    const attempts: { resource: string; json: unknown }[] = [
      { resource: "tasks", json: { title: "X", projectId: ids.projectA } },
      { resource: "tasks", json: { title: "X", contactId: ids.contactA } },
      { resource: "activities", json: { title: "X", kind: "note", contactIds: [ids.contactA] } },
      { resource: "transactions", json: txBody(ids.accountA) },
      { resource: "transactions", json: txBody(ids.accountB, { contactId: ids.contactA }) },
      { resource: "transactions", json: txBody(ids.accountB, { receiptId: ids.receiptA }) },
    ];
    for (const attempt of attempts) {
      const { db, d1 } = seedWorld();
      setEnv(d1);
      asUser(B);
      const before = snap(db);
      const res = await call(routes.list, "POST", base + "/api/data/" + attempt.resource, { params: { resource: attempt.resource }, json: attempt.json });
      assert4xx(res.status, res.body);
      assertSame(db, before);
    }
  });
});

test("B's own activity stores user_id on the child link and does not surface A's contact", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const created = await call(routes.list, "POST", base + "/api/data/activities", { params: { resource: "activities" }, json: { title: "Reunion", kind: "note", contactIds: [ids.contactB] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { id: string }).id;
    const link = db.prepare("SELECT user_id AS userId, contact_id AS contactId FROM activity_contacts WHERE activity_id=? AND user_id=?").get(id, B) as { userId: string; contactId: string };
    assert.equal(link.userId, B);
    assert.equal(link.contactId, ids.contactB);
    const listed = await call(routes.list, "GET", base + "/api/data/activities", { params: { resource: "activities" } });
    assertNoA(listed.body);
    assert.match(JSON.stringify(listed.body), /Reunion/);
  });
});

test("avatar of A's contact is invisible and not writable", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const before = snap(db);
    const read = await call(routes.avatar, "GET", base + "/api/avatar/" + ids.contactA, { params: { id: ids.contactA } });
    assert.equal(read.status, 404);
    const write = await call(routes.avatar, "POST", base + "/api/avatar/" + ids.contactA, { params: { id: ids.contactA }, json: { failedKey: "email:a-secret@test.local" } });
    assert4xx(write.status, write.body);
    assertSame(db, before);
    const own = await call(routes.avatar, "GET", base + "/api/avatar/" + ids.contactB, { params: { id: ids.contactB } });
    assert.equal(own.status, 200);
  });
});

test("a non-admin cannot list or change users", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    setEnv(d1);
    asUser(B);
    const routes = await api();
    const before = snap(db);
    const listed = await call(routes.admin, "GET", base + "/api/admin/users");
    assert.equal(listed.status, 403);
    assert.deepEqual(listed.body, { error: "Forbidden" });
    const changed = await call(routes.adminUser, "PATCH", base + "/api/admin/users/" + A, { params: { userId: A }, json: { approvalStatus: "rejected" } });
    assert.equal(changed.status, 403);
    assertSame(db, before);
    asUser(A, "admin");
    const allowed = await call(routes.admin, "GET", base + "/api/admin/users");
    assert.equal(allowed.status, 200);
    assert.ok((allowed.body as { users: { id: string }[] }).users.some((user) => user.id === B));
  });
});
