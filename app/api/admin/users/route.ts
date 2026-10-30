import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const result = await env.DB.prepare(
    "SELECT id, name, email, approvalStatus, createdAt FROM user ORDER BY createdAt DESC"
  ).all();

  return NextResponse.json({ users: result.results });
}
