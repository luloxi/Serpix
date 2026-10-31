import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectAssetHashes,
  createManifest,
  hashWorkerFile,
  readCommit,
  writeManifest,
} from "./lib/build-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, ".open-next", "assets");
const workerFile = path.join(root, ".open-next", "worker.js");

if (!existsSync(assetsDir)) {
  console.error("Missing .open-next/assets. Run opennextjs-cloudflare build first.");
  process.exit(1);
}

const files = await collectAssetHashes(assetsDir);
const worker = hashWorkerFile(workerFile);
const manifest = createManifest({
  commit: readCommit(root),
  builtAt: new Date().toISOString(),
  files,
  worker,
});
const written = await writeManifest(assetsDir, manifest);
console.log(
  `Wrote ${path.relative(root, written)} (${Object.keys(manifest.files).length} files, worker ${worker ? "hashed" : "absent"}, commit ${manifest.commit ?? "null"})`,
);
