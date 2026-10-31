import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { getFinanceTotals } from "@/lib/finance";

export const dynamic = "force-dynamic";

async function context() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB };
}

export async function GET() {
  const ctx = await context();
  if ("response" in ctx) return ctx.response;
  return NextResponse.json(await getFinanceTotals(ctx.db, ctx.userId));
}
