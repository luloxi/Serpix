import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindSwrUser, clearSwrCache, readSwr, swrCacheable, swrPaths, SWR_PREFIX, transactionsPath, writeSwr } from "../lib/swr-cache.ts";

function installStorage(): void {
  const map = new Map<string, string>();
  const order: string[] = [];
  const ls: Storage = {
    get length() { return order.length; },
    key(index: number) { return order[index] ?? null; },
    getItem(key: string) { return map.has(key) ? map.get(key)! : null; },
    setItem(key: string, value: string) {
      if (!map.has(key)) order.push(key);
      map.set(key, String(value));
    },
    removeItem(key: string) {
      if (!map.has(key)) return;
      map.delete(key);
      order.splice(order.indexOf(key), 1);
    },
    clear() { map.clear(); order.length = 0; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
}

test("list views round-trip under serpix:swr:<userId>:<endpoint>", () => {
  installStorage();
  const endpoint = swrPaths.contacts;
  assert.equal(swrCacheable(endpoint), true);
  assert.equal(swrCacheable(transactionsPath(250)), true);
  assert.equal(swrCacheable(swrPaths.lumaEvents), true);
  assert.equal(readSwr<unknown[]>("ana", endpoint), null);
  writeSwr("ana", endpoint, [{ id: "c1", name: "Ana" }]);
  assert.equal(localStorage.getItem(SWR_PREFIX + "uid"), "ana");
  assert.deepEqual(readSwr("ana", endpoint), [{ id: "c1", name: "Ana" }]);
  assert.equal(localStorage.getItem(SWR_PREFIX + "ana:" + endpoint), JSON.stringify([{ id: "c1", name: "Ana" }]));
});

test("settings, the Luma link, auth, passwords, tokens and secrets are never stored", () => {
  installStorage();
  const blocked = [
    "/api/settings/luma",
    "/api/settings/luma/sync",
    "/api/auth/session",
    "/api/e2e/keys",
    "/api/push/subscribe",
    "/api/invites/redeem",
    "/api/documents/doc-1",
    "/api/admin/users/user-1",
    "/api/data/contacts?token=abc",
    "/api/data/transactions?limit=250&password=nope",
    "password",
    "/api/receipts/scan",
  ];
  for (const endpoint of blocked) {
    assert.equal(swrCacheable(endpoint), false, endpoint);
    writeSwr("ana", endpoint, { secret: "no" });
    assert.equal(readSwr("ana", endpoint), null, endpoint);
  }
  assert.equal([...keys()].some((key) => key.includes("settings") || key.includes("token") || key.includes("password")), false);
});

test("a different stored user id drops every serpix:swr key and logout clears them", () => {
  installStorage();
  localStorage.setItem("serpix-theme", "dark");
  localStorage.setItem("serpix-timer", "{\"timer\":1}");
  writeSwr("ana", swrPaths.tasks, [{ id: "t1" }]);
  writeSwr("ana", swrPaths.documents, { items: [], today: "2026-11-01" });
  assert.equal(readSwr<unknown[]>("ana", swrPaths.tasks)?.length, 1);
  bindSwrUser("leo");
  assert.equal(localStorage.getItem(SWR_PREFIX + "ana:" + swrPaths.tasks), null);
  assert.equal(localStorage.getItem(SWR_PREFIX + "uid"), "leo");
  assert.equal([...keys()].filter((key) => key.startsWith(SWR_PREFIX)).join(","), SWR_PREFIX + "uid");
  writeSwr("leo", swrPaths.inquiries, [{ id: "i1" }]);
  clearSwrCache();
  assert.deepEqual([...keys()].filter((key) => key.startsWith(SWR_PREFIX)), []);
  assert.equal(localStorage.getItem("serpix-theme"), "dark");
  assert.equal(localStorage.getItem("serpix-timer"), "{\"timer\":1}");
});

test("leftover keys from another user are cleared even without a stored id", () => {
  installStorage();
  localStorage.setItem(SWR_PREFIX + "ana:" + swrPaths.contacts, "[]");
  bindSwrUser("leo");
  assert.equal(localStorage.getItem(SWR_PREFIX + "ana:" + swrPaths.contacts), null);
  assert.equal(localStorage.getItem(SWR_PREFIX + "uid"), "leo");
});

test("logout and the views wire the cache, and sensitive screens do not", () => {
  const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const signOut = read("app/sign-out-button.tsx");
  const pending = read("app/pending/page.tsx");
  const workspace = read("app/workspace.tsx");
  const luma = read("app/luma-settings.tsx");
  const gate = read("app/e2e-gate.tsx");
  assert.match(signOut, /clearSwrCache\(\)/);
  assert.match(pending, /clearSwrCache\(\)/);
  assert.match(workspace, /actualizando…/);
  assert.match(workspace, /if\(e2e\)\{clearSwrCache\(\);return;\}/);
  assert.match(workspace, /bindSwrUser\(userId\)/);
  assert.equal(luma.includes("swr-cache"), false);
  assert.equal(luma.includes("localStorage"), false);
  assert.match(gate, /userId=\{userId\}/);
  assert.equal(read("app/brand.css").includes("swr-status"), false);
});

function keys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) out.push(key);
  }
  return out;
}
