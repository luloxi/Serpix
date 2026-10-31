import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { PrfUnsupportedError } from "../lib/crypto/passkey.ts";
import { createVault, unlockWithPasskey, unlockWithPassword, vault } from "../lib/crypto/vault.ts";
import type { KeyWrap } from "../lib/e2e-server.ts";
import { startEngine, type Engine } from "../lib/e2e/engine.ts";
import { fromStoredWrap, toStoredWrap } from "../lib/e2e/wraps.ts";
import { openDb, user } from "./db-helper.mts";
import { fakeAuthenticator } from "./helpers/fake-authenticator.ts";
import { asUser, call, locked, setEnv } from "./route-harness.mts";

const wasm = readFileSync(new URL("../public/vendor/sql-wasm.wasm", import.meta.url));
const BASE = "http://t.local";
const password = "Correct-Horse-99";
const email = "ada@example.com";
const userId = "recover-user";

const routes = {
  list: await import("../app/api/e2e/records/route.ts"),
  record: await import("../app/api/e2e/records/[collection]/[id]/route.ts"),
  counter: await import("../app/api/e2e/counter/route.ts"),
  keys: await import("../app/api/e2e/keys/route.ts"),
};

async function serverFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  let mod: Record<string, (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>> | null = null;
  let params: Record<string, string> = {};
  if (url.pathname === "/api/e2e/records") mod = routes.list;
  else if (url.pathname === "/api/e2e/counter") mod = routes.counter;
  else if (url.pathname === "/api/e2e/keys") mod = routes.keys;
  else {
    const match = url.pathname.match(/^\/api\/e2e\/records\/([^/]+)\/([^/]+)$/);
    if (match) {
      mod = routes.record;
      params = { collection: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
    }
  }
  if (!mod) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  const text = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const result = await call(mod, request.method, request.url, { text, params, headers });
  return new Response(result.text, { status: result.status, headers: result.headers });
}

test("a new device unlocks with the recovery password and ignores a passkey without PRF", { timeout: 300_000 }, async () => {
  await locked(async () => {
    const { db, d1 } = openDb();
    user(db, userId);
    asUser(userId);
    setEnv(d1);
    const authenticator = fakeAuthenticator(crypto.getRandomValues(new Uint8Array(32)), "prf");
    vault.clear();
    const created = await createVault({
      userId,
      email,
      password,
      passkey: { userName: email, rpId: "serpix.example", challenge: new Uint8Array(32).fill(7), credentials: authenticator },
      wrapIds: { password: "pw-1", passkey: "pk-1" },
      deps: { appUrl: "https://serpix.example", timer: { elapsed: () => 50 }, idb: new IDBFactory(), remember: false },
    });
    assert.ok(created.wraps.passkey);
    const passwordStored = toStoredWrap(created.wraps.password);
    const passkeyStored = toStoredWrap(created.wraps.passkey);
    const first = await call(routes.keys, "POST", BASE + "/api/e2e/keys", { json: { type: "password", wrap: passwordStored.wrap, id: "pw-1" } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await call(routes.keys, "POST", BASE + "/api/e2e/keys", { json: { type: "passkey", wrap: passkeyStored.wrap, credentialId: passkeyStored.credentialId, id: "pk-1" } });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const engine = await startEngine({ userId, dek: created.dekKey, fetch: serverFetch, wasm, name: userId, email, baseUrl: BASE });
    let fresh: Engine | null = null;
    try {
      const saved = await engine.handle(BASE + "/api/data/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada Lovelace", notes: "recuperable" }),
      });
      assert.equal(saved.status, 201, await saved.text());
      await engine.push();

      const listed = await call(routes.keys, "GET", BASE + "/api/e2e/keys");
      assert.equal(listed.status, 200);
      const wraps = (listed.body as { wraps: { id: string; type: string; wrap: unknown; credentialId: string | null }[] }).wraps;
      const passwordRow = wraps.find((row) => row.type === "password");
      const passkeyRow = wraps.find((row) => row.type === "passkey");
      assert.ok(passwordRow && passkeyRow);
      const passwordWrap = fromStoredWrap(passwordRow.id, userId, passwordRow.wrap as KeyWrap, null);
      const passkeyWrap = fromStoredWrap(passkeyRow.id, userId, passkeyRow.wrap as KeyWrap, passkeyRow.credentialId);
      await assert.rejects(() => unlockWithPassword({ password: passwordWrap }, "wrong-password-99", { userId, wrapId: passwordRow.id }));
      const noPrf = {
        async create() { return null; },
        async get() {
          return {
            type: "public-key" as const,
            id: passkeyRow.credentialId ?? "x",
            rawId: new Uint8Array(16).buffer,
            response: { clientDataJSON: new ArrayBuffer(2) },
            getClientExtensionResults() { return {}; },
          };
        },
      };
      await assert.rejects(
        () => unlockWithPasskey({ passkey: passkeyWrap }, { userId, wrapId: passkeyRow.id }, { credentials: noPrf, rpId: "serpix.example", challenge: new Uint8Array(32).fill(9) }),
        PrfUnsupportedError,
      );
      const dek = await unlockWithPassword({ password: passwordWrap }, password, { userId, wrapId: passwordRow.id });
      fresh = await startEngine({
        userId,
        dek,
        fetch: serverFetch,
        wasm,
        name: userId,
        email,
        baseUrl: BASE,
      });
      const contacts = await fresh.handle(BASE + "/api/data/contacts");
      const body = await contacts.json() as { items: { name: string; notes: string }[] };
      assert.equal(contacts.status, 200);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].name, "Ada Lovelace");
      assert.equal(body.items[0].notes, "recuperable");
    } finally {
      await engine.close();
      if (fresh) await fresh.close();
      vault.clear();
    }
  });
});
