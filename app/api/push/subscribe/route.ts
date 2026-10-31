import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

// Public VAPID key (needed by the browser to subscribe) + whether this endpoint is already subscribed.
export async function GET(request: Request) {
  const c = await approvedContext(); if (!c) return unauthorized();
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  let subscribed = false;
  if (endpoint) subscribed = Boolean(await c.env.DB.prepare("SELECT 1 AS x FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(endpoint, c.userId).first());
  return NextResponse.json({ publicKey: c.env.VAPID_PUBLIC_KEY || null, subscribed }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const c = await approvedContext(); if (!c) return unauthorized();
  let b: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try { b = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "", p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh : "", auth = typeof b.keys?.auth === "string" ? b.keys.auth : "";
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?").bind(c.userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return NextResponse.json({ error: "Demasiados dispositivos" }, { status: 400 });
  // A device that changes hands (A logged out without cleaning up, B signs in on the same phone) may take the endpoint over only by proving it holds the subscription keys. Someone who merely knows an endpoint URL cannot grab another user's subscription.
  const owned = await c.env.DB.prepare("SELECT user_id AS userId, p256dh, auth FROM push_subscriptions WHERE endpoint=?").bind(endpoint).first<{ userId: string; p256dh: string; auth: string }>();
  if (owned && owned.userId !== c.userId && (owned.p256dh !== p256dh || owned.auth !== auth)) return NextResponse.json({ error: "Suscripción inválida" }, { status: 409 });
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  await c.env.DB.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent").bind(crypto.randomUUID(), c.userId, endpoint, p256dh, auth, ua, Date.now()).run();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const c = await approvedContext(); if (!c) return unauthorized();
  let b: { endpoint?: unknown };
  try { b = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof b.endpoint !== "string") return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const result = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(b.endpoint, c.userId).run();
  if (result.meta.changes === 0) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
