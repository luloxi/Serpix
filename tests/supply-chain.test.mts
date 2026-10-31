import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lock = { lockfileVersion: number; packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Pkg;
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lock;
const direct = { ...pkg.dependencies, ...pkg.devDependencies };
const EXACT = /^\d+\.\d+\.\d+$/;

test("every direct dependency is an exact version (no latest, no ranges)", () => {
  for (const [name, range] of Object.entries(direct)) {
    assert.match(range, EXACT, `${name} is "${range}", expected an exact x.y.z`);
  }
});

test("package-lock.json is committed and agrees with package.json", () => {
  assert.ok(lock.lockfileVersion >= 3);
  const root = lock.packages[""];
  assert.deepEqual(root.dependencies ?? {}, pkg.dependencies ?? {});
  assert.deepEqual(root.devDependencies ?? {}, pkg.devDependencies ?? {});
  for (const [name, version] of Object.entries(direct)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} locked at a different version`);
  }
});
