import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

test("e2e controls use a pointer and a not-allowed cursor when disabled", () => {
  const css = read("app/e2e.css");
  assert.match(css, /\.e2e-gate button,\s*\.e2e-menu button[\s\S]*cursor:\s*pointer/);
  assert.match(css, /\.e2e-btn\s*\{[\s\S]*cursor:\s*pointer/);
  assert.match(css, /\.e2e-gate button:disabled[\s\S]*cursor:\s*not-allowed/);
  assert.match(css, /\.e2e-ai[\s\S]*cursor:\s*pointer/);
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(css), false);
  for (const file of ["app/e2e-gate.tsx", "app/e2e-menu.tsx"]) {
    const source = read(file);
    assert.match(source, /className="e2e-btn/);
    assert.equal(source.includes("pagehide"), false);
    assert.equal(source.includes("cursor:"), false);
  }
  const receipt = read("app/receipt-field.tsx");
  assert.match(receipt, /className="e2e-ai"/);
  const layout = read("app/layout.tsx");
  assert.ok(layout.indexOf('import "./brand.css"') < layout.indexOf('import "./e2e.css"'));
});

test("admin renders Workspace directly and a non-admin goes through the gate", () => {
  const page = read("app/dashboard/page.tsx");
  const admin = page.indexOf('session.user.role === "admin"');
  const workspace = page.indexOf("<Workspace name={name} email={email} image={image} isAdmin />");
  const mode = page.indexOf("encryptionMode(");
  const gate = page.indexOf("<E2eGateSlot");
  assert.ok(admin > -1 && workspace > admin && mode > workspace && gate > mode);
  const slot = read("app/e2e-gate-slot.tsx");
  assert.match(slot, /ssr:\s*false/);
  assert.match(slot, /import\("\.\/e2e-gate"\)/);
  assert.match(page, /shouldMountGate/);
  assert.equal(page.includes("pagehide"), false);
  assert.equal(page.slice(0, mode).includes("encryptionMode("), false);

  const gateSource = read("app/e2e-gate.tsx");
  assert.match(gateSource, /LEGACY_DATA_ERROR/);
  assert.match(gateSource, /isAdmin=\{false\}/);
  assert.match(gateSource, /e2e e2eMenu=\{<E2eMenu/);
  assert.equal(gateSource.toLowerCase().includes("inhackeable"), false);
  assert.match(gateSource, /installFetch:\s*false/);

  const workspaceSource = read("app/workspace.tsx");
  assert.match(workspaceSource, /e2eMenu\?:\s*ReactNode/);
  assert.match(workspaceSource, /\{e2eMenu\}/);
  assert.match(workspaceSource, /<ReceiptField [^>]*e2e=\{e2e\}/);
  // Source-level guard: no automatic third-party avatar lookup for encrypted accounts.
  assert.match(workspaceSource, /const autoLoadAvatar=async\(c:Item\)=>\{[^\n]*\n[^\n]*\n\s*if\(e2e\|\|autoLimited/);
});
