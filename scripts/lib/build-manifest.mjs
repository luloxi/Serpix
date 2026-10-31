import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_VERSION = 1;
export const MANIFEST_PUBLIC_PATH = "/.well-known/build.json";
/** Cloudflare asset meta files. They are not served, so they are not part of the manifest. */
export const UNSERVED_PATHS = new Set(["/_headers", "/_redirects", "/.assetsignore"]);
export const VERIFY_CONCURRENCY = 8;

export function sha256Prefixed(bytes) {
  return "sha256-" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * SHA-256 of the OpenNext worker bundle, the same value stored in `manifest.worker`.
 * Null when the file is absent.
 */
export function hashWorkerFile(file) {
  try {
    return sha256Prefixed(readFileSync(file));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Paths the URL checker fetches. Everything else stays in the manifest for a manual audit. */
export function isVerifiedPath(urlPath) {
  // First-party scripts from public/. theme-init.js runs with the CSP nonce, and strict-dynamic lets it load more scripts.
  if (urlPath === "/sw.js" || urlPath === "/theme-init.js") return true;
  if (urlPath.startsWith("/manifest")) return true;
  if (urlPath === "/_next/static" || urlPath.startsWith("/_next/static/")) return true;
  if (urlPath === "/icons" || urlPath.startsWith("/icons/")) return true;
  if (urlPath === "/vendor" || urlPath.startsWith("/vendor/")) return true;
  return false;
}

export function toPublicPath(root, file) {
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes the asset root");
  return "/" + rel.split(path.sep).join("/");
}

function skipped(urlPath) {
  return urlPath === MANIFEST_PUBLIC_PATH || UNSERVED_PATHS.has(urlPath);
}

export async function collectAssetHashes(root) {
  const files = {};
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const urlPath = toPublicPath(root, abs);
      if (skipped(urlPath)) continue;
      files[urlPath] = sha256Prefixed(await readFile(abs));
    }
  }
  await walk(root);
  return files;
}

export function createManifest({ commit, builtAt, files, worker }) {
  const sorted = {};
  for (const key of Object.keys(files).sort()) {
    if (skipped(key)) continue;
    sorted[key] = files[key];
  }
  return {
    v: MANIFEST_VERSION,
    commit: commit ?? null,
    builtAt,
    files: sorted,
    worker: worker ?? null,
  };
}

export function serializeManifest(manifest) {
  const ordered = createManifest(manifest);
  return JSON.stringify(ordered, null, 2) + "\n";
}

export async function writeManifest(assetRoot, manifest) {
  const target = path.join(assetRoot, ".well-known", "build.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serializeManifest(manifest));
  return target;
}

export function readCommit(repoRoot) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export function safeAssetPath(root, urlPath) {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/") || urlPath.includes("\0")) {
    throw new Error("Unsafe manifest path");
  }
  const parts = urlPath.split("/");
  if (parts.some((part) => part === "..")) throw new Error("Unsafe manifest path");
  const full = path.resolve(root, "." + urlPath);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Unsafe manifest path");
  return full;
}

export async function hashAssetFile(root, urlPath) {
  try {
    return sha256Prefixed(await readFile(safeAssetPath(root, urlPath)));
  } catch {
    return null;
  }
}

export function diffManifest(manifest, actualByPath, paths) {
  const failures = [];
  for (const urlPath of paths) {
    const expected = manifest.files[urlPath];
    const actual = actualByPath[urlPath];
    if (expected === undefined) {
      failures.push({ path: urlPath, reason: "not-in-manifest", expected: null, actual: actual ?? null });
    } else if (actual == null) {
      failures.push({ path: urlPath, reason: "missing", expected, actual: null });
    } else if (actual !== expected) {
      failures.push({ path: urlPath, reason: "mismatch", expected, actual });
    }
  }
  return failures;
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

export function verifiedPaths(manifest) {
  return Object.keys(manifest.files).filter(isVerifiedPath).sort();
}

export function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.v !== MANIFEST_VERSION) {
    throw new Error("Manifest must be version 1");
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Manifest files must be an object");
  }
}

/** Compare a manifest to hashes produced by `load(path) -> sha256-hex | null`. */
export async function verifyAgainst(manifest, load, concurrency = VERIFY_CONCURRENCY) {
  assertManifestShape(manifest);
  const paths = verifiedPaths(manifest);
  const actualByPath = {};
  await mapPool(paths, concurrency, async (urlPath) => {
    actualByPath[urlPath] = await load(urlPath);
  });
  const failures = diffManifest(manifest, actualByPath, paths);
  return {
    checked: paths.length,
    skipped: Object.keys(manifest.files).length - paths.length,
    failures,
  };
}

export function formatSummary(result) {
  const lines = [
    `checked ${result.checked}, failed ${result.failures.length}, skipped ${result.skipped} (not under /_next/static, /icons, /vendor, /sw.js, /theme-init.js, /manifest*)`,
  ];
  for (const failure of result.failures) {
    lines.push(`${failure.reason} ${failure.path}`);
    if (failure.expected) lines.push(`  expected ${failure.expected}`);
    if (failure.actual) lines.push(`  actual   ${failure.actual}`);
    if (failure.artifact) lines.push(`  artifact ${failure.artifact}`);
  }
  return lines.join("\n");
}
