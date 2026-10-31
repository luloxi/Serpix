import path from "node:path";
import { readFile } from "node:fs/promises";
import { formatSummary, hashAssetFile, sha256Prefixed, verifyAgainst } from "./lib/build-manifest.mjs";

function usage() {
  console.error("Usage: node scripts/verify-build.mjs <baseUrl>");
  console.error("       node scripts/verify-build.mjs --local <dir>");
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

async function verifyLocal(dir) {
  const root = path.resolve(dir);
  const manifest = await readManifest(path.join(root, ".well-known", "build.json"));
  return verifyAgainst(manifest, (urlPath) => hashAssetFile(root, urlPath));
}

async function verifyUrl(baseUrl) {
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
  return verifyAgainst(manifest, async (urlPath) => {
    const fileUrl = new URL(urlPath, base.origin);
    try {
      const file = await fetch(fileUrl, { signal: AbortSignal.timeout(20_000) });
      if (!file.ok) return null;
      return sha256Prefixed(Buffer.from(await file.arrayBuffer()));
    } catch {
      return null;
    }
  });
}

const args = process.argv.slice(2);
let result;
try {
  if (args[0] === "--local") {
    if (!args[1] || args[2]) {
      usage();
      process.exit(1);
    }
    result = await verifyLocal(args[1]);
  } else if (args.length === 1 && !args[0].startsWith("-")) {
    result = await verifyUrl(args[0]);
  } else {
    usage();
    process.exit(1);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(formatSummary(result));
if (result.failures.length > 0) process.exit(1);
