import { sendPush, type VapidConfig } from "@/lib/webpush";

export const INQUIRY_LIMITS = { name: 80, email: 254, message: 5000, budget: 2000, ref: 40 } as const;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type InquiryInput = { name: string; email: string; message: string; budgetJson: string | null; refCode: string | null };

/** Validates the payload sent by the portfolio. Returns the error code or the clean input. */
export function parseInquiry(raw: unknown): { error: string } | { value: InquiryInput } {
  if (!raw || typeof raw !== "object") return { error: "invalid_json" };
  const b = raw as Record<string, unknown>;
  const name = clean(b.name, INQUIRY_LIMITS.name).replace(/[\r\n]+/g, " ");
  const email = clean(b.email, INQUIRY_LIMITS.email);
  const message = clean(b.message, INQUIRY_LIMITS.message);
  if (!name) return { error: "invalid_name" };
  if (!EMAIL_RE.test(email)) return { error: "invalid_email" };
  if (!message) return { error: "invalid_message" };
  let budgetJson: string | null = null;
  if (b.budget !== undefined && b.budget !== null) {
    const s = typeof b.budget === "string" ? b.budget : JSON.stringify(b.budget);
    if (s.length > INQUIRY_LIMITS.budget) return { error: "invalid_budget" };
    try { JSON.parse(s); budgetJson = s; } catch { return { error: "invalid_budget" }; }
  }
  const refCode = clean(b.refCode, INQUIRY_LIMITS.ref) || null;
  return { value: { name, email, message, budgetJson, refCode } };
}

/** Constant-time string comparison (hash both sides first so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

type Db = { prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown>; all: <T>() => Promise<{ results: T[] }> } } };

/** Push a "new inquiry" notification to every subscription of the user. Dead subscriptions (404/410) are removed. Never throws. */
export async function notifyInquiry(db: Db, userId: string, inquiry: { id: string; name: string; message: string }, cfg: VapidConfig, doFetch: typeof fetch = fetch): Promise<number> {
  let sent = 0;
  try {
    const subs = (await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?").bind(userId).all<{ id: string; endpoint: string; p256dh: string; auth: string }>()).results;
    const preview = inquiry.message.replace(/\s+/g, " ").slice(0, 120);
    const msg = { title: `Nueva solicitud · ${inquiry.name}`, body: preview, url: `/dashboard?solicitudes=${inquiry.id}`, tag: `inquiry-${inquiry.id}` };
    await Promise.all(subs.map(async (s) => {
      try {
        const status = await sendPush(s, msg, cfg, doFetch);
        if (status === 404 || status === 410) await db.prepare("DELETE FROM push_subscriptions WHERE id=? AND user_id=?").bind(s.id, userId).run();
        else if (status >= 200 && status < 300) { sent++; await db.prepare("UPDATE push_subscriptions SET last_ok_at=? WHERE id=?").bind(Date.now(), s.id).run(); }
      } catch { /* one bad endpoint must not stop the others */ }
    }));
  } catch { /* notification is best effort */ }
  return sent;
}
