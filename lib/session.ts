import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

async function readSession() {
  const auth = await getAuth();
  return auth.api.getSession({ headers: await headers() });
}

/** Any signed-in user, any approval status. Null without a session (callers answer 401). */
export async function sessionContext() {
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

type ApprovedSession = NonNullable<Awaited<ReturnType<typeof approvedContext>>>;

/** approvedContext, or { encrypted: true } when the account is in e2e mode. Null means 401. */
export async function legacyDataContext(): Promise<ApprovedSession | { encrypted: true } | null> {
  const ctx = await approvedContext();
  if (!ctx) return null;
  const row = await ctx.db.prepare("SELECT encryption_mode AS mode FROM user WHERE id = ?").bind(ctx.userId).first<{ mode: string }>();
  if (row?.mode === "e2e") return { encrypted: true };
  return ctx;
}

/** Same as approvedContext, but only when session.user.role === "admin". Null otherwise. */
export async function adminContext() {
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
