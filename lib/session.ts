import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

/** Approved session + bindings, or null (callers answer 401). */
export async function approvedContext() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return null;
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB, env };
}
