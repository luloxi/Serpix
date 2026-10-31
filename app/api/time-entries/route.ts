import { NextResponse } from "next/server";
import { approvedContext } from "@/lib/session";
import { entryAmountMinor, parseTimeEntryBody } from "@/lib/timer";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  const result = await ctx.db.prepare(
    "SELECT e.id, e.task_id AS taskId, t.title AS taskTitle, e.started_at AS startedAt, e.ended_at AS endedAt, e.duration_ms AS durationMs, e.billable AS billable, e.hourly_rate_minor AS hourlyRateMinor, e.amount_minor AS amountMinor, e.currency AS currency, e.description AS description, e.created_at AS createdAt FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id WHERE e.user_id = ? ORDER BY e.started_at DESC, e.created_at DESC LIMIT 300",
  ).bind(ctx.userId).all();
  return json({ items: result.results });
}

export async function POST(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  let raw: unknown;
  try { raw = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const parsed = parseTimeEntryBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const value = parsed.value;
  const { db, userId } = ctx;
  try {
    if (value.taskId) {
      const task = await db.prepare("SELECT id FROM tasks WHERE id=? AND user_id=?").bind(value.taskId, userId).first();
      if (!task) return json({ error: "Tarea inválida" }, 400);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const amount = entryAmountMinor(value.durationMs, value.hourlyRateMinor, value.billable);
    const insert = db.prepare(
      "INSERT INTO time_entries (id,user_id,task_id,started_at,ended_at,duration_ms,billable,hourly_rate_minor,amount_minor,currency,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, userId, value.taskId, value.startedAt, value.endedAt, value.durationMs, value.billable ? 1 : 0, value.hourlyRateMinor, amount, "ARS", value.description, now);
    if (value.fromTimer) {
      const del = db.prepare("DELETE FROM timer_state WHERE user_id=?").bind(userId);
      await db.batch([insert, del]);
    } else {
      await insert.run();
    }
    return json({ ok: true, id }, 201);
  } catch (error) {
    console.error("time_entry_create_failed", String(error));
    return json({ error: "No se pudo guardar el registro" }, 500);
  }
}
