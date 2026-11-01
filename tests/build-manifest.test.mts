import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
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

test("verified paths cover static prefixes and first-party scripts", () => {
  assert.equal(isVerifiedPath("/_next/static/chunks/a.js"), true);
  assert.equal(isVerifiedPath("/icons/icon-192.v7.png"), true);
  assert.equal(isVerifiedPath("/vendor/sql.wasm"), true);
  assert.equal(isVerifiedPath("/sw.js"), true);
  assert.equal(isVerifiedPath("/manifest-v7.webmanifest"), true);
  assert.equal(isVerifiedPath("/theme-init.js"), true);
  assert.equal(isVerifiedPath("/theme-init.js/"), false);
  assert.equal(isVerifiedPath("/public/theme-init.js"), false);
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

    const load = async (urlPath) => {
      try {
        return sha256Prefixed(await readFile(path.join(dir, urlPath.slice(1))));
      } catch {
        return null;
      }
    };
    const ok = await verifyAgainst(manifest, load);
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.checked, 3);
    assert.equal(ok.skipped, 0);

    await writeFile(path.join(dir, "sw.js"), "tampered");
    const bad = await verifyAgainst(manifest, load);
    assert.equal(bad.failures.length, 1);
    assert.equal(bad.failures[0]?.path, "/sw.js");
    assert.equal(bad.failures[0]?.reason, "mismatch");

    const workerFile = path.join(dir, "worker-artifact.js");
    await writeFile(workerFile, "worker");
    const cli = path.resolve("scripts/verify-build.mjs");
    const cliArgs = [cli, "--local", dir, "--worker", workerFile];
    const passed = spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
    assert.equal(passed.status, 1, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /mismatch \/sw\.js/);
    assert.equal(passed.stdout.includes("mismatch worker"), false);

    await writeFile(path.join(dir, "sw.js"), "abc");
    await writeFile(path.join(dir, "theme-init.js"), "tampered-theme");
    const themeBad = await verifyAgainst(manifest, load);
    assert.equal(themeBad.failures.length, 1);
    assert.equal(themeBad.failures[0]?.path, "/theme-init.js");
    assert.equal(themeBad.failures[0]?.reason, "mismatch");
    await writeFile(path.join(dir, "theme-init.js"), "theme");

    const again = spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /failed 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-build checks theme-init.js and the local worker artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "serpix-verify-"));
  const assets = path.join(dir, "assets");
  const workerFile = path.join(dir, "worker.js");
  const theme = "theme-bytes";
  const workerBytes = "worker-bytes";
  const themeHash = sha256Prefixed(Buffer.from(theme));
  const workerHash = sha256Prefixed(Buffer.from(workerBytes));
  const cli = path.resolve("scripts/verify-build.mjs");
  const run = () => spawnSync(process.execPath, [cli, "--local", assets, "--worker", workerFile], { encoding: "utf8" });
  try {
    await mkdir(path.join(assets, ".well-known"), { recursive: true });
    await writeFile(path.join(assets, "theme-init.js"), theme);
    await writeFile(workerFile, workerBytes);
    const claimed = {
      commit: null,
      builtAt: "2026-10-31T00:00:00.000Z",
      files: { "/theme-init.js": themeHash },
      worker: workerHash,
    };
    await writeManifest(assets, createManifest(claimed));

    const matched = run();
    assert.equal(matched.status, 0, matched.stdout + matched.stderr);
    assert.match(matched.stdout, /checked 2,/);
    assert.match(matched.stdout, /failed 0/);

    await writeFile(path.join(assets, "theme-init.js"), "tampered-theme");
    const themeBad = run();
    assert.equal(themeBad.status, 1, themeBad.stdout + themeBad.stderr);
    assert.match(themeBad.stdout, /mismatch \/theme-init\.js/);
    assert.match(themeBad.stdout, /failed 1/);
    assert.equal(themeBad.stdout.includes("mismatch worker"), false);

    await writeFile(path.join(assets, "theme-init.js"), theme);
    await writeFile(workerFile, "tampered-worker");
    const workerBad = run();
    assert.equal(workerBad.status, 1, workerBad.stdout + workerBad.stderr);
    assert.match(workerBad.stdout, /mismatch worker/);
    assert.match(workerBad.stdout, new RegExp(workerHash));
    assert.equal(workerBad.stdout.includes("mismatch /theme-init.js"), false);

    await rm(workerFile);
    const workerMissing = run();
    assert.equal(workerMissing.status, 1, workerMissing.stdout + workerMissing.stderr);
    assert.match(workerMissing.stdout, /missing worker/);
    assert.match(workerMissing.stdout, new RegExp(workerHash));
    assert.match(workerMissing.stdout, /artifact .*[/\\]worker\.js/);

    await writeManifest(
      assets,
      createManifest({ ...claimed, worker: null }),
    );
    const unclaimed = run();
    assert.equal(unclaimed.status, 0, unclaimed.stdout + unclaimed.stderr);
    assert.match(unclaimed.stdout, /checked 1,/);
    assert.match(unclaimed.stdout, /failed 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-build fetches asset bytes from the URL and the worker hash from the local artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "serpix-verify-url-"));
  const workerFile = path.join(dir, "worker.js");
  const theme = "theme-bytes";
  let servedTheme = theme;
  const themeHash = sha256Prefixed(Buffer.from(theme));
  const workerBytes = "worker-bytes";
  const workerHash = sha256Prefixed(Buffer.from(workerBytes));
  const manifest = createManifest({
    commit: null,
    builtAt: "2026-10-31T00:00:00.000Z",
    files: { "/theme-init.js": themeHash },
    worker: workerHash,
  });
  const requested = [];
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    requested.push(urlPath);
    if (urlPath === "/.well-known/build.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (urlPath === "/theme-init.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(servedTheme);
      return;
    }
    res.writeHead(404);
    res.end("absent");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("verify server did not bind");
  const cli = path.resolve("scripts/verify-build.mjs");
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, `http://127.0.0.1:${address.port}/`, "--worker", workerFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  try {
    await writeFile(workerFile, workerBytes);
    const matched = await run();
    assert.equal(matched.status, 0, matched.stdout + matched.stderr);
    assert.match(matched.stdout, /checked 2,/);
    assert.match(matched.stdout, /failed 0/);
    assert.deepEqual(requested, ["/.well-known/build.json", "/theme-init.js"]);

    servedTheme = "tampered-theme";
    const themeBad = await run();
    assert.equal(themeBad.status, 1, themeBad.stdout + themeBad.stderr);
    assert.match(themeBad.stdout, /mismatch \/theme-init\.js/);
    assert.equal(themeBad.stdout.includes("mismatch worker"), false);

    servedTheme = theme;
    await writeFile(workerFile, "tampered-worker");
    const workerBad = await run();
    assert.equal(workerBad.status, 1, workerBad.stdout + workerBad.stderr);
    assert.match(workerBad.stdout, /mismatch worker/);
    assert.equal(workerBad.stdout.includes("mismatch /theme-init.js"), false);
    assert.equal(requested.some((urlPath) => urlPath.includes("worker")), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
});
