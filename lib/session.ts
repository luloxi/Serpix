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
