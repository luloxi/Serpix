import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
async function ctx() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return null;
  const { env } = await getCloudflareContext({ async: true });
  return { env, userId: session.user.id };
}
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// Public VAPID key (needed by the browser to subscribe) + whether this endpoint is already subscribed.
export async function GET(request: Request) {
  const c = await ctx(); if (!c) return unauthorized();
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  let subscribed = false;
  if (endpoint) subscribed = Boolean(await c.env.DB.prepare("SELECT 1 AS x FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(endpoint, c.userId).first());
  return NextResponse.json({ publicKey: c.env.VAPID_PUBLIC_KEY || null, subscribed }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const c = await ctx(); if (!c) return unauthorized();
  let b: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try { b = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "", p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh : "", auth = typeof b.keys?.auth === "string" ? b.keys.auth : "";
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?").bind(c.userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return NextResponse.json({ error: "Demasiados dispositivos" }, { status: 400 });
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  await c.env.DB.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent").bind(crypto.randomUUID(), c.userId, endpoint, p256dh, auth, ua, Date.now()).run();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const c = await ctx(); if (!c) return unauthorized();
  let b: { endpoint?: unknown };
  try { b = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof b.endpoint !== "string") return NextResponse.json({ error: "Invalid" }, { status: 400 });
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(b.endpoint, c.userId).run();
  return NextResponse.json({ ok: true });
}
