import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

type Approved = {
  userId: string;
  db: Awaited<ReturnType<typeof getCloudflareContext>>["env"]["DB"];
  env: Awaited<ReturnType<typeof getCloudflareContext>>["env"];
  name: string;
  email: string;
  role: string;
};

async function loadApproved(): Promise<Approved | null> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
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

function publish(s: Approved) {
  return { userId: s.userId, db: s.db, env: s.env, name: s.name, email: s.email };
}

/** Approved session + bindings, or null (callers answer 401). */
export async function approvedContext() {
  const s = await loadApproved();
  return s ? publish(s) : null;
}

/** Same as approvedContext, but only when session.user.role === "admin". Null otherwise. */
export async function adminContext() {
  const s = await loadApproved();
  if (!s || s.role !== "admin") return null;
  return publish(s);
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
