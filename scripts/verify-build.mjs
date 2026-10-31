import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatSummary, hashAssetFile, hashWorkerFile, sha256Prefixed, verifyAgainst } from "./lib/build-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkerFile = path.join(repoRoot, ".open-next", "worker.js");

function usage() {
  console.error("Usage: node scripts/verify-build.mjs <baseUrl> [--worker <file>]");
  console.error("       node scripts/verify-build.mjs --local <dir> [--worker <file>]");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function readManifest(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(`Could not read ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`Manifest is not JSON: ${file}`);
  }
}

function parseArgs(argv) {
  let localDir;
  let baseUrl;
  let workerFile;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--local") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-") || localDir !== undefined) return null;
      localDir = value;
      i += 1;
      continue;
    }
    if (arg === "--worker") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-") || workerFile !== undefined) return null;
      workerFile = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-") || baseUrl !== undefined) return null;
    baseUrl = arg;
  }
  if (localDir !== undefined && baseUrl !== undefined) return null;
  if (localDir === undefined && baseUrl === undefined) return null;
  return {
    mode: localDir !== undefined ? "local" : "url",
    target: localDir ?? baseUrl,
    workerFile: path.resolve(workerFile ?? defaultWorkerFile),
  };
}

/** Compare `manifest.worker` to the local build artifact when the manifest publishes a hash. */
function applyWorkerCheck(result, manifest, workerFile) {
  if (manifest.worker == null) return result;
  const actual = hashWorkerFile(workerFile);
  let failure = null;
  if (actual == null) {
    failure = { path: "worker", reason: "missing", expected: manifest.worker, actual: null, artifact: workerFile };
  } else if (actual !== manifest.worker) {
    failure = { path: "worker", reason: "mismatch", expected: manifest.worker, actual, artifact: workerFile };
  }
  return {
    checked: result.checked + 1,
    skipped: result.skipped,
    failures: failure ? [...result.failures, failure] : result.failures,
  };
}

async function verifyLocal(dir, workerFile) {
  const root = path.resolve(dir);
  const manifest = await readManifest(path.join(root, ".well-known", "build.json"));
  const result = await verifyAgainst(manifest, (urlPath) => hashAssetFile(root, urlPath));
  return applyWorkerCheck(result, manifest, workerFile);
}

async function verifyUrl(baseUrl, workerFile) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    fail(`Not a URL: ${baseUrl}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") fail(`Unsupported URL scheme: ${base.protocol}`);
  const manifestUrl = new URL("/.well-known/build.json", base.origin);
  let response;
  try {
    response = await fetch(manifestUrl, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    fail(`Could not fetch ${manifestUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`Manifest ${manifestUrl} returned ${response.status}`);
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    fail(`Manifest ${manifestUrl} is not JSON`);
  }
  const result = await verifyAgainst(manifest, async (urlPath) => {
    const fileUrl = new URL(urlPath, base.origin);
    try {
      const file = await fetch(fileUrl, { signal: AbortSignal.timeout(20_000) });
      if (!file.ok) return null;
      return sha256Prefixed(Buffer.from(await file.arrayBuffer()));
    } catch {
      return null;
    }
  });
  return applyWorkerCheck(result, manifest, workerFile);
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  usage();
  process.exit(1);
}

let result;
try {
  result =
    args.mode === "local"
      ? await verifyLocal(args.target, args.workerFile)
      : await verifyUrl(args.target, args.workerFile);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(formatSummary(result));
if (result.failures.length > 0) process.exit(1);
