import { NextResponse } from "next/server";
import { approvedContext } from "@/lib/session";
import { pauseTimer, resumeTimer, startTimer, type TimerState } from "@/lib/timer";

export const dynamic = "force-dynamic";

type TimerRow = { startedAt: number; segmentStart: number | null; accumulatedMs: number };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function toTimer(row: TimerRow): TimerState {
  return {
    startedAt: Number(row.startedAt),
    segmentStart: row.segmentStart == null ? null : Number(row.segmentStart),
    accumulatedMs: Number(row.accumulatedMs),
  };
}

const SELECT = "SELECT started_at AS startedAt, segment_start AS segmentStart, accumulated_ms AS accumulatedMs FROM timer_state WHERE user_id=?";

export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  const row = await ctx.db.prepare(SELECT).bind(ctx.userId).first<TimerRow>();
  return json({ timer: row ? toTimer(row) : null, serverNow: Date.now() });
}

export async function POST(request: Request) {
  const ctx = await approvedContext();
  if (!ctx) return json({ error: "Unauthorized" }, 401);
  let body: { action?: unknown };
  try { body = await request.json() as { action?: unknown }; } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = body.action;
  if (action !== "start" && action !== "pause" && action !== "resume" && action !== "discard") return json({ error: "Acción inválida" }, 400);
  const { db, userId } = ctx;
  const now = Date.now();
  try {
    const row = await db.prepare(SELECT).bind(userId).first<TimerRow>();
    const current = row ? toTimer(row) : null;
    if (action === "discard") {
      await db.prepare("DELETE FROM timer_state WHERE user_id=?").bind(userId).run();
      return json({ timer: null, serverNow: now });
    }
    if (action === "start") {
      if (current) return json({ timer: current, serverNow: now });
      const timer = startTimer(now);
      try {
        await db.prepare("INSERT INTO timer_state (user_id, started_at, segment_start, accumulated_ms, updated_at) VALUES (?,?,?,?,?)").bind(userId, timer.startedAt, timer.segmentStart, timer.accumulatedMs, now).run();
      } catch {
        const again = await db.prepare(SELECT).bind(userId).first<TimerRow>();
        if (again) return json({ timer: toTimer(again), serverNow: Date.now() });
        throw new Error("timer_insert_failed");
      }
      return json({ timer, serverNow: now });
    }
    if (!current) return json({ timer: null, serverNow: now });
    if (action === "pause") {
      if (current.segmentStart == null) return json({ timer: current, serverNow: now });
      const next = pauseTimer(current, now);
      await db.prepare("UPDATE timer_state SET segment_start=NULL, accumulated_ms=?, updated_at=? WHERE user_id=?").bind(next.accumulatedMs, now, userId).run();
      return json({ timer: next, serverNow: now });
    }
    if (current.segmentStart != null) return json({ timer: current, serverNow: now });
    const next = resumeTimer(current, now);
    await db.prepare("UPDATE timer_state SET segment_start=?, updated_at=? WHERE user_id=?").bind(next.segmentStart, now, userId).run();
    return json({ timer: next, serverNow: now });
  } catch (error) {
    console.error("timer_update_failed", String(error));
    return json({ error: "No se pudo actualizar el temporizador" }, 500);
  }
}
