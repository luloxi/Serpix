// Resolve hook for route isolation tests. Registered via node:module register() from route-harness.mts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const shim = (name) => new URL("./shims/" + name, import.meta.url).href;
const SHIMS = {
  "next/server": shim("next-server.mjs"),
  "next/headers": shim("next-headers.mjs"),
  "@opennextjs/cloudflare": shim("cloudflare.mjs"),
};

function isAuthSpecifier(specifier, parentURL) {
  if (specifier === "@/lib/auth" || specifier === "@/lib/auth.ts" || specifier === "@/lib/auth.js") return true;
  if (!specifier.startsWith(".") || !parentURL) return false;
  try {
    const abs = fileURLToPath(new URL(specifier, parentURL));
    return /\/lib\/auth\.(ts|tsx|js|mjs)$/.test(abs);
  } catch {
    return false;
  }
}

function aliasUrl(specifier) {
  if (!specifier.startsWith("@/")) return null;
  const rel = specifier.slice(2);
  const base = join(root, rel);
  const candidates = [base, base + ".ts", base + ".tsx", base + ".mts", base + ".js", join(base, "index.ts"), join(base, "index.tsx")];
  for (const file of candidates) {
    if (existsSync(file)) return pathToFileURL(file).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (SHIMS[specifier]) return { url: SHIMS[specifier], shortCircuit: true };
  if (isAuthSpecifier(specifier, context.parentURL)) return { url: shim("auth.mjs"), shortCircuit: true };
  const aliased = aliasUrl(specifier);
  if (aliased) return { url: aliased, shortCircuit: true };
  return nextResolve(specifier, context);
}
