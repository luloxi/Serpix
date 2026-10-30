import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { env } = await getCloudflareContext({ async: true });
  const r = await env.DB.prepare("SELECT id, name, email, message, budget_json AS budgetJson, ref_code AS refCode, status, contact_id AS contactId, created_at AS createdAt FROM inquiries WHERE user_id=? ORDER BY created_at DESC LIMIT 300").bind(session.user.id).all();
  return NextResponse.json({ items: r.results }, { headers: { "Cache-Control": "no-store" } });
}
