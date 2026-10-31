import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_EXTERNAL_CONTINUE,
  AVATAR_EXTERNAL_WARNING,
  autoEligible,
  avatarFetchStep,
  shouldAutoAvatarOnSave,
} from "../lib/avatar-client.ts";

const eligible = { hasAvatar: 0, avatarTriedKey: "", avatarTriedAt: 0 };
const key = "email:ada@example.com";

test("saving a contact looks up a photo only when the account is not encrypted", async () => {
  const base = {
    resource: "contacts",
    hasAvatarDataInValues: false,
    hasPhoto: false,
    key,
    eligible: autoEligible(eligible, key),
  };
  let calls = 0;
  const lookup = async () => { calls += 1; };
  if (shouldAutoAvatarOnSave({ ...base, e2e: true })) await lookup();
  assert.equal(calls, 0);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: true }), false);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false }), true);
  if (shouldAutoAvatarOnSave({ ...base, e2e: false })) await lookup();
  assert.equal(calls, 1);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false, hasPhoto: true }), false);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false, hasAvatarDataInValues: true }), false);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false, resource: "tasks" }), false);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false, key: "" }), false);
  assert.equal(shouldAutoAvatarOnSave({ ...base, e2e: false, eligible: false }), false);
});

test("an encrypted account confirms before a manual Gravatar or unavatar fetch", () => {
  assert.equal(avatarFetchStep(false, false), "fetch");
  assert.equal(avatarFetchStep(true, false), "confirm");
  assert.equal(avatarFetchStep(true, true), "fetch");
  assert.match(AVATAR_EXTERNAL_WARNING, /Gravatar/);
  assert.match(AVATAR_EXTERNAL_WARNING, /unavatar\.io/);
  assert.match(AVATAR_EXTERNAL_WARNING, /dispositivo/);
  assert.equal(AVATAR_EXTERNAL_CONTINUE, "Continuar");
});
