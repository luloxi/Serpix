import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ADMIN_EMAIL } from "@/lib/auth";
import { notifyInquiry, parseInquiry, safeEqual } from "@/lib/inquiries";

export const dynamic = "force-dynamic";
const MAX_BODY = 12_000;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Portfolio contact form -> Serpix. Called by the portfolio Worker (Service Binding), authenticated with the shared secret.
// Anything wrong (no/wrong secret, bad body, too big, too many) is rejected before touching the database.
export async function POST(request: Request) {
  const { env, ctx } = await getCloudflareContext({ async: true });
  const secret = env.PORTFOLIO_INBOUND_SECRET;
  const given = request.headers.get("x-serpix-secret") ?? "";
  if (!secret || !given || !(await safeEqual(given, secret))) return json({ error: "unauthorized" }, 401);
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json({ error: "too_large" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
  const parsed = parseInquiry(raw);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const v = parsed.value;

  const owner = await env.DB.prepare("SELECT id FROM user WHERE lower(email)=? LIMIT 1").bind(ADMIN_EMAIL).first<{ id: string }>();
  if (!owner) return json({ error: "no_owner" }, 503);
  const now = Date.now();
  // Basic flood guard on top of the portfolio's own limits: max 30 per 10 minutes overall, 5 per hour per email.
  const flood = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM inquiries WHERE user_id=? AND created_at>?) AS total, (SELECT COUNT(*) FROM inquiries WHERE user_id=? AND lower(email)=? AND created_at>?) AS mine").bind(owner.id, now - 600_000, owner.id, v.email.toLowerCase(), now - 3_600_000).first<{ total: number; mine: number }>();
  if ((flood?.total ?? 0) >= 30 || (flood?.mine ?? 0) >= 5) return json({ error: "rate_limited" }, 429);

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO inquiries (id,user_id,source,name,email,message,budget_json,ref_code,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, owner.id, "portfolio", v.name, v.email, v.message, v.budgetJson, v.refCode, "new", now).run();
  if (env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY) {
    ctx.waitUntil(notifyInquiry(env.DB, owner.id, { id, name: v.name, message: v.message }, { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: `mailto:${ADMIN_EMAIL}` }));
  }
  return json({ ok: true, id }, 201);
}
