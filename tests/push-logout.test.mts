import test from "node:test";
import assert from "node:assert/strict";
import { removeDevicePush, signOutClearingPush, type PushLogoutDeps } from "../lib/push-logout.ts";

function deps(over: Partial<PushLogoutDeps> & { events: string[] }): PushLogoutDeps {
  return {
    timeoutMs: 1000,
    async fetch(_input, init) {
      over.events.push("delete:" + String(init?.method) + ":" + String(init?.body));
    },
    async getRegistration() {
      return {
        pushManager: {
          async getSubscription() {
            return {
              endpoint: "https://push.example.test/this-device",
              async unsubscribe() { over.events.push("unsub"); },
            };
          },
        },
      };
    },
    ...over,
  };
}

test("logout deletes the server subscription before unsubscribe, then signs out", async () => {
  const events: string[] = [];
  await signOutClearingPush(async () => { events.push("signout"); }, deps({ events }));
  assert.deepEqual(events, [
    "delete:DELETE:" + JSON.stringify({ endpoint: "https://push.example.test/this-device" }),
    "unsub",
    "signout",
  ]);
});

test("no subscription skips the network and still signs out", async () => {
  const events: string[] = [];
  await signOutClearingPush(async () => { events.push("signout"); }, {
    async fetch() { events.push("fetch"); },
    async getRegistration() { return { pushManager: { async getSubscription() { return null; } } }; },
  });
  assert.deepEqual(events, ["signout"]);
});

test("a failed delete still unsubscribes and does not block sign-out", async () => {
  const events: string[] = [];
  await signOutClearingPush(async () => { events.push("signout"); }, deps({
    events,
    async fetch() { events.push("delete"); throw new Error("offline"); },
  }));
  assert.deepEqual(events, ["delete", "unsub", "signout"]);
});

test("a hung registration does not block past the timeout", async () => {
  const started = Date.now();
  let signed = false;
  await signOutClearingPush(async () => { signed = true; }, {
    timeoutMs: 40,
    async fetch() { throw new Error("should not fetch"); },
    getRegistration: () => new Promise(() => {}),
  });
  assert.equal(signed, true);
  assert.ok(Date.now() - started < 500);
});

test("removeDevicePush resolves when unsubscribe throws", async () => {
  await removeDevicePush({
    async fetch() {},
    async getRegistration() {
      return { pushManager: { async getSubscription() { return { endpoint: "https://push.example.test/x", async unsubscribe() { throw new Error("gone"); } }; } } };
    },
  });
});
