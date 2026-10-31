import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectAssetHashes,
  createManifest,
  diffManifest,
  isVerifiedPath,
  serializeManifest,
  sha256Prefixed,
  verifyAgainst,
  writeManifest,
} from "../scripts/lib/build-manifest.mjs";

const SHA_ABC = "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("sha256 prefix matches the known vector", () => {
  assert.equal(sha256Prefixed(Buffer.from("abc")), SHA_ABC);
});

test("manifest ordering is deterministic and the manifest does not list itself", () => {
  const input = {
    commit: "abc123",
    builtAt: "2026-10-31T00:00:00.000Z",
    worker: "sha256-worker",
    files: {
      "/b.js": "sha256-b",
      "/.well-known/build.json": "sha256-self",
      "/_headers": "sha256-meta",
      "/a.js": "sha256-a",
    },
  };
  const first = createManifest(input);
  const second = createManifest({ ...input, files: { "/a.js": "sha256-a", "/b.js": "sha256-b" } });
  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.deepEqual(Object.keys(JSON.parse(serializeManifest(first))), ["v", "commit", "builtAt", "files", "worker"]);
  assert.deepEqual(Object.keys(first.files), ["/a.js", "/b.js"]);
  assert.equal(first.files["/.well-known/build.json"], undefined);
  assert.equal(first.files["/_headers"], undefined);
  assert.equal(first.commit, "abc123");
  assert.equal(first.worker, "sha256-worker");
  assert.equal(createManifest({ ...input, commit: null, worker: null }).commit, null);
  assert.equal(createManifest({ ...input, commit: null, worker: null }).worker, null);
});

test("verified paths are only the static prefixes", () => {
  assert.equal(isVerifiedPath("/_next/static/chunks/a.js"), true);
  assert.equal(isVerifiedPath("/icons/icon-192.v5.png"), true);
  assert.equal(isVerifiedPath("/vendor/sql.wasm"), true);
  assert.equal(isVerifiedPath("/sw.js"), true);
  assert.equal(isVerifiedPath("/manifest-v5.webmanifest"), true);
  assert.equal(isVerifiedPath("/theme-init.js"), false);
  assert.equal(isVerifiedPath("/api/data/contacts"), false);
  assert.equal(isVerifiedPath("/_next/static-other/a.js"), false);
  assert.equal(isVerifiedPath("/icons-other/a.png"), false);
});

test("diff reports a mismatch and a missing file, and ignores paths outside the check", () => {
  const manifest = createManifest({
    commit: null,
    builtAt: "2026-10-31T00:00:00.000Z",
    worker: null,
    files: {
      "/sw.js": SHA_ABC,
      "/theme-init.js": "sha256-theme",
      "/icons/a.png": "sha256-icon",
    },
  });
  const failures = diffManifest(manifest, { "/sw.js": "sha256-other", "/icons/a.png": "sha256-icon" }, [
    "/sw.js",
    "/icons/a.png",
    "/vendor/missing.js",
  ]);
  assert.deepEqual(
    failures.map((failure) => failure.reason + " " + failure.path),
    ["mismatch /sw.js", "not-in-manifest /vendor/missing.js"],
  );
  const checked = diffManifest(manifest, { "/sw.js": SHA_ABC, "/icons/a.png": "sha256-icon" }, ["/sw.js", "/icons/a.png"]);
  assert.deepEqual(checked, []);
});

test("a directory round-trip matches, a changed file does not, and the manifest file is excluded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "serpix-manifest-"));
  try {
    await mkdir(path.join(dir, "icons"), { recursive: true });
    await mkdir(path.join(dir, ".well-known"), { recursive: true });
    await writeFile(path.join(dir, "icons", "a.png"), "png-bytes");
    await writeFile(path.join(dir, "sw.js"), "abc");
    await writeFile(path.join(dir, "_headers"), "not served");
    await writeFile(path.join(dir, ".well-known", "build.json"), "stale");
    await writeFile(path.join(dir, "theme-init.js"), "theme");

    const files = await collectAssetHashes(dir);
    assert.equal(files["/.well-known/build.json"], undefined);
    assert.equal(files["/_headers"], undefined);
    assert.equal(files["/sw.js"], SHA_ABC);
    assert.equal(files["/theme-init.js"], sha256Prefixed(Buffer.from("theme")));

    const manifest = createManifest({
      commit: "deadbeef",
      builtAt: "2026-10-31T00:00:00.000Z",
      files,
      worker: sha256Prefixed(Buffer.from("worker")),
    });
    await writeManifest(dir, manifest);
    const written = JSON.parse(await readFile(path.join(dir, ".well-known", "build.json"), "utf8"));
    assert.equal(written.files["/.well-known/build.json"], undefined);
    assert.deepEqual(Object.keys(written.files).sort(), Object.keys(written.files));

    const ok = await verifyAgainst(manifest, (urlPath) => {
      const rel = urlPath.slice(1);
      return readFile(path.join(dir, rel)).then((buf) => sha256Prefixed(buf), () => null);
    });
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.checked, 2);
    assert.equal(ok.skipped, 1);

    await writeFile(path.join(dir, "sw.js"), "tampered");
    const bad = await verifyAgainst(manifest, async (urlPath) => {
      try {
        return sha256Prefixed(await readFile(path.join(dir, urlPath.slice(1))));
      } catch {
        return null;
      }
    });
    assert.equal(bad.failures.length, 1);
    assert.equal(bad.failures[0]?.path, "/sw.js");
    assert.equal(bad.failures[0]?.reason, "mismatch");

    const cli = path.resolve("scripts/verify-build.mjs");
    const passed = spawnSync(process.execPath, [cli, "--local", dir], { encoding: "utf8" });
    assert.equal(passed.status, 1, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /mismatch \/sw\.js/);

    await writeFile(path.join(dir, "sw.js"), "abc");
    const again = spawnSync(process.execPath, [cli, "--local", dir], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /failed 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
