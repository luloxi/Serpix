import { NextResponse } from "next/server";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext } from "@/lib/session";
import { generateDue, isDateKey, todayInBuenosAires } from "@/lib/recurring";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** { action: "pause" | "resume" | "end" } or an edit of amount, category, description, account and end date (future movements only). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "Invalid JSON" }, 400); }
  const { db, userId } = ctx, now = Date.now(), today = todayInBuenosAires(now);
  const rule = await db.prepare("SELECT status, anchor_date AS anchorDate FROM recurring_rules WHERE id=? AND user_id=?").bind(id, userId).first<{ status: string; anchorDate: string }>();
  if (!rule) return json({ error: "Regla inexistente" }, 404);
  try {
    if (b.action === "pause" || b.action === "end") {
      try { await generateDue(db, userId, today); } catch (error) {
        const blocked = encryptedWriteResponse(error);
        if (blocked) return blocked;
      }
    }
    if (b.action === "pause") {
      if (rule.status !== "active") return json({ error: "Solo se puede pausar una regla activa" }, 409);
      await db.prepare("UPDATE recurring_rules SET status='paused',updated_at=? WHERE id=? AND user_id=?").bind(now, id, userId).run();
      return json({ ok: true });
    }
    if (b.action === "resume") {
      if (rule.status !== "paused") return json({ error: "Solo se puede reanudar una regla pausada" }, 409);
      // Resume from today: the paused period is not back-filled.
      await db.prepare("UPDATE recurring_rules SET status='active',from_date=?,updated_at=? WHERE id=? AND user_id=?").bind(today, now, id, userId).run();
      return json({ ok: true });
    }
    if (b.action === "end") {
      if (rule.status === "ended") return json({ ok: true });
      await db.prepare("UPDATE recurring_rules SET status='ended',end_date=CASE WHEN end_date IS NULL OR end_date>? THEN ? ELSE end_date END,updated_at=? WHERE id=? AND user_id=?").bind(today, today, now, id, userId).run();
      return json({ ok: true });
    }
    if (rule.status === "ended") return json({ error: "La regla terminó. Creá otra marcando un movimiento como recurrente." }, 409);
    const amount = Number(b.amountMinor), category = str(b.category, 80), accountId = str(b.accountId, 80);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !category) return json({ error: "Importe o categoría inválidos" }, 400);
    const end = str(b.endDate, 10) || null;
    if (end !== null && (!isDateKey(end) || end < rule.anchorDate)) return json({ error: "Fecha de fin inválida" }, 400);
    if (!(await db.prepare("SELECT id FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId, userId).first())) return json({ error: "Cuenta inválida" }, 400);
    await db.prepare("UPDATE recurring_rules SET amount_minor=?,category=?,description=?,account_id=?,end_date=?,updated_at=? WHERE id=? AND user_id=?")
      .bind(amount, category, str(b.description) || null, accountId, end, now, id, userId).run();
    return json({ ok: true });
  } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    throw error;
  }
}

/** Deletes the rule only; the movements it already created stay (their recurring link is cleared). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await legacyDataContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  if ("encrypted" in ctx) return encryptedAccount();
  const { id } = await params;
  const result = await ctx.db.prepare("DELETE FROM recurring_rules WHERE id=? AND user_id=?").bind(id, ctx.userId).run();
  if (result.meta.changes === 0) return json({ error: "Regla inexistente" }, 404);
  return json({ ok: true });
}
