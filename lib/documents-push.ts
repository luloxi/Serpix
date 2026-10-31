// Overdue-invoice push: one notification per user listing the invoices that just became overdue. Best effort, never throws.
import { sendPush, type VapidConfig } from "./webpush.ts";
import { overdueInvoices, type DocDb } from "./documents.ts";
import { formatMoney } from "./document-pdf.ts";

type Row = { id: string; number: number; currency: string; totalMinor: number; contactName: string | null };

/** "2 facturas vencidas sin cobrar · $ 100,00 + US$ 50,00" */
export function overdueMessage(rows: Row[]): { title: string; body: string; url: string; tag: string } {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.totalMinor);
  const sum = [...totals].map(([c, v]) => formatMoney(v, c)).join(" + ");
  const who = rows.length === 1 && rows[0].contactName ? ` · ${rows[0].contactName}` : "";
  return { title: rows.length === 1 ? `Factura vencida sin cobrar${who}` : `${rows.length} facturas vencidas sin cobrar`, body: sum, url: "/", tag: "overdue-invoices" };
}

type PushDb = DocDb;

/**
 * Finds users with overdue, unpaid invoices that were never notified, sends ONE push each and marks them.
 * Invoices are marked only if at least one push got through (or the user has no subscriptions: nothing to retry).
 */
export async function notifyOverdueInvoices(db: PushDb, today: string, cfg: VapidConfig, doFetch: typeof fetch = fetch): Promise<{ users: number; invoices: number; pushes: number }> {
  const out = { users: 0, invoices: 0, pushes: 0 };
  try {
    const users = (await db.prepare("SELECT DISTINCT user_id AS userId FROM documents WHERE doc_type='invoice' AND status='sent' AND due_date IS NOT NULL AND due_date < ? AND overdue_notified_on IS NULL").bind(today).all<{ userId: string }>()).results ?? [];
    for (const { userId } of users) {
      try {
        const all = await overdueInvoices(db, userId, today);
        const pending = (await db.prepare("SELECT id FROM documents WHERE user_id=? AND doc_type='invoice' AND status='sent' AND overdue_notified_on IS NULL AND due_date < ?").bind(userId, today).all<{ id: string }>()).results ?? [];
        if (!pending.length) continue;
        const subs = (await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?").bind(userId).all<{ id: string; endpoint: string; p256dh: string; auth: string }>()).results ?? [];
        let ok = 0;
        const msg = overdueMessage(all as Row[]);
        for (const s of subs) {
          try {
            const status = await sendPush(s, msg, cfg, doFetch);
            if (status === 404 || status === 410) await db.prepare("DELETE FROM push_subscriptions WHERE id=? AND user_id=?").bind(s.id, userId).run();
            else if (status >= 200 && status < 300) { ok++; await db.prepare("UPDATE push_subscriptions SET last_ok_at=? WHERE id=?").bind(Date.now(), s.id).run(); }
          } catch { /* next endpoint */ }
        }
        out.users++; out.pushes += ok;
        if (ok > 0 || subs.length === 0) {
          for (const p of pending) await db.prepare("UPDATE documents SET overdue_notified_on=? WHERE id=? AND user_id=?").bind(today, p.id, userId).run();
          out.invoices += pending.length;
        }
      } catch { /* one user must not block the rest */ }
    }
  } catch { /* cron is best effort */ }
  return out;
}
