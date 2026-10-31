import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LOCAL_SCHEMA_SQL } from "../lib/e2e/schema.ts";

test("generated local schema matches the migrations", () => {
  const result = spawnSync(process.execPath, ["scripts/gen-local-schema.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, (result.stdout || "") + (result.stderr || ""));
  assert.match(LOCAL_SCHEMA_SQL, /CREATE TABLE contacts/);
  assert.match(LOCAL_SCHEMA_SQL, /avatar_data/);
  assert.match(LOCAL_SCHEMA_SQL, /excluded_from_totals/);
  assert.match(LOCAL_SCHEMA_SQL, /recurring_period/);
  assert.equal(LOCAL_SCHEMA_SQL.includes("encryption_mode"), false);
  assert.equal(LOCAL_SCHEMA_SQL.includes("integration_nonces"), false);
});
