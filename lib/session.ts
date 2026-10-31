import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { engineSessionOverride, installNodeEngineSession } from "@/lib/e2e/node-session";

// The browser bundle aliases this module away and never evaluates this file.
installNodeEngineSession();

type LocalApproved = {
  userId: string;
  db: D1Database;
  env: CloudflareEnv;
  name: string;
  email: string;
  role: string;
  approvalStatus: string;
};

function localSession(): LocalApproved | null {
  const local = engineSessionOverride();
  if (!local) return null;
  return {
    userId: local.userId,
    db: local.db as D1Database,
    env: local.env as unknown as CloudflareEnv,
    name: local.name ?? "",
    email: local.email ?? "",
    role: local.role || "user",
    approvalStatus: local.approvalStatus ?? "approved",
  };
}

async function readSession() {
  const auth = await getAuth();
  return auth.api.getSession({ headers: await headers() });
}

/** Any signed-in user, any approval status. Null without a session (callers answer 401). */
export async function sessionContext() {
  const local = localSession();
  if (local) return { userId: local.userId, role: local.role, approvalStatus: local.approvalStatus, db: local.db, env: local.env };
  const session = await readSession();
  if (!session?.user) return null;
  const { env } = await getCloudflareContext({ async: true });
  return {
    userId: session.user.id,
    role: session.user.role ?? "",
    approvalStatus: session.user.approvalStatus ?? "",
    db: env.DB,
    env,
  };
}

/** Approved session + bindings, or null (callers answer 401). */
export async function approvedContext() {
  const local = localSession();
  if (local) {
    if (local.approvalStatus !== "approved") return null;
    return { userId: local.userId, db: local.db, env: local.env, name: local.name, email: local.email, role: local.role };
  }
  const session = await readSession();
  if (!session || session.user.approvalStatus !== "approved") return null;
  const { env } = await getCloudflareContext({ async: true });
  return {
    userId: session.user.id,
    db: env.DB,
    env,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role ?? "",
  };
}

/** Plaintext routes refuse an e2e account with this body (403). */
export const ENCRYPTED_ACCOUNT_ERROR = "Cuenta cifrada: usá el modo cifrado de la app.";

export function encryptedAccount() {
  return NextResponse.json({ error: ENCRYPTED_ACCOUNT_ERROR }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

import { E2E_PLAINTEXT_WRITE, isE2ePlaintextWrite } from "@/lib/e2e/plaintext-error";

export { E2E_PLAINTEXT_WRITE, isE2ePlaintextWrite };

/** The same 403 as encryptedAccount() when a plaintext INSERT/UPDATE was aborted. Null for every other error. */
export function encryptedWriteResponse(error: unknown) {
  return isE2ePlaintextWrite(error) ? encryptedAccount() : null;
}

type ApprovedSession = NonNullable<Awaited<ReturnType<typeof approvedContext>>>;

/**
 * approvedContext only when encryption_mode is exactly "server".
 * Any other stored mode, including NULL, is { encrypted: true } (callers answer 403).
 * Null means 401: no approved session, or a session whose user row is gone.
 */
export async function legacyDataContext(): Promise<ApprovedSession | { encrypted: true } | null> {
  // The local working set is plaintext and has no encryption_mode column.
  if (localSession()) return approvedContext();
  const ctx = await approvedContext();
  if (!ctx) return null;
  const row = await ctx.db.prepare("SELECT encryption_mode AS mode FROM user WHERE id = ?").bind(ctx.userId).first<{ mode: string | null }>();
  if (!row) return null;
  if (row.mode !== "server") return { encrypted: true };
  return ctx;
}

/** Same as approvedContext, but only when session.user.role === "admin". Null otherwise. */
export async function adminContext() {
  const local = localSession();
  if (local) {
    if (local.role !== "admin" || local.approvalStatus !== "approved") return null;
    return { userId: local.userId, db: local.db, env: local.env, name: local.name, email: local.email, role: local.role };
  }
  const session = await readSession();
  if (!session || session.user.approvalStatus !== "approved" || session.user.role !== "admin") return null;
  const { env } = await getCloudflareContext({ async: true });
  return {
    userId: session.user.id,
    db: env.DB,
    env,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role ?? "",
  };
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
