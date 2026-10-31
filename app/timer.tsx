"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Clock, Pause, Play, Square, Trash2, X } from "lucide-react";
import {
  adjustedNow, applyEndInput, applyStartInput, clockSkew, elapsedMs, entryAmountMinor, epochToLocalInput,
  formatHMS, formatHM, formatTracked, initialEntryWindow, MAX_DURATION_MS, MAX_HOURLY_RATE_MINOR, MIN_DURATION_MS, NUDGE_MS,
  parseTimerState, roundUpEnd, nudgeEnd, type TimerState,
} from "@/lib/timer";

export type TimeEntry = {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  billable: number | boolean;
  hourlyRateMinor: number;
  amountMinor: number;
  currency: string;
  description: string | null;
  createdAt: number;
};

export type TimerView = "closed" | "sheet" | "stopping";

type TaskLike = { id: string; title?: unknown; status?: unknown };
type Draft = {
  startedAt: number;
  endedAt: number;
  taskId: string;
  billable: boolean;
  hourlyRateMinor: number;
  description: string;
};

const TIMER_CACHE = "serpix-timer";
const RATE_KEY = "serpix-hourly-rate";

export function readTimerCache(): { timer: TimerState; skewMs: number } | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(TIMER_CACHE);
    if (!raw) return null;
    const data = JSON.parse(raw) as { timer?: unknown; skewMs?: unknown };
    const timer = parseTimerState(data.timer);
    if (!timer) return null;
    const skewMs = typeof data.skewMs === "number" && Number.isFinite(data.skewMs) ? data.skewMs : 0;
    return { timer, skewMs };
  } catch {
    return null;
  }
}

export function writeTimerCache(timer: TimerState | null, skewMs: number) {
  try {
    if (!timer) localStorage.removeItem(TIMER_CACHE);
    else localStorage.setItem(TIMER_CACHE, JSON.stringify({ timer, skewMs }));
  } catch { /* private mode */ }
}

function readHourlyRate(): number {
  try {
    const n = Number(localStorage.getItem(RATE_KEY));
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_HOURLY_RATE_MINOR) return 0;
    return n;
  } catch {
    return 0;
  }
}

function writeHourlyRate(minor: number) {
  try { localStorage.setItem(RATE_KEY, String(minor)); } catch { /* private mode */ }
}

function formatARS(minor: number): string {
  const n = Number.isFinite(minor) ? minor / 100 : 0;
  return "ARS " + new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-AR", { timeZone: "America/Buenos_Aires", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Client clock for display. Sampled outside render; the interval only refreshes a running timer. */
function useClock(ticking: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useLayoutEffect(() => {
    const sample = () => setNow(Date.now());
    sample();
    if (!ticking) return;
    const id = window.setInterval(sample, 500);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

export default function TimerHost({ timer, skewMs, view, tasks, onView, onTimer, onEntry, onNotice, onError }: {
  timer: TimerState | null;
  skewMs: number;
  view: TimerView;
  tasks: TaskLike[];
  onView: (view: TimerView) => void;
  onTimer: (timer: TimerState | null, skewMs: number) => void;
  onEntry: (entry: TimeEntry) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stopKey, setStopKey] = useState(0);
  const busyRef = useRef(false);
  const draftRef = useRef<Draft | null>(null);
  const setDraftSync = useCallback((updater: (current: Draft | null) => Draft | null) => {
    const next = updater(draftRef.current);
    draftRef.current = next;
    setDraft(next);
  }, []);
  const running = !!timer && timer.segmentStart != null && view !== "stopping";
  const now = useClock(running);
  // Before the clock is sampled, a running segment contributes 0 so SSR and the first client render match.
  const elapsed = timer ? elapsedMs(timer, now == null ? (timer.segmentStart ?? 0) : now + skewMs) : 0;
  const paused = !timer || timer.segmentStart == null;

  const mutate = useCallback(async (action: "start" | "pause" | "resume" | "discard") => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/timer", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ action }) });
      const body = await response.json().catch(() => null) as { error?: string; timer?: unknown; serverNow?: unknown } | null;
      if (!response.ok || !body || typeof body.serverNow !== "number") {
        onError(body?.error || "No se pudo actualizar el temporizador");
        return null;
      }
      const next = body.timer == null ? null : parseTimerState(body.timer);
      if (body.timer != null && !next) {
        onError("No se pudo leer el temporizador");
        return null;
      }
      const skew = clockSkew(body.serverNow, Date.now());
      onTimer(next, skew);
      return { timer: next, serverNow: body.serverNow, skew };
    } catch {
      onError("No se pudo actualizar el temporizador");
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onError, onTimer]);

  const onStartEvent = useCallback(async () => {
    if (timer) { onView("sheet"); return; }
    if (busyRef.current) return;
    const result = await mutate("start");
    if (result?.timer) onView("sheet");
  }, [timer, mutate, onView]);

  useEffect(() => {
    const handler = () => { void onStartEvent(); };
    window.addEventListener("serpix:timer-start", handler);
    return () => window.removeEventListener("serpix:timer-start", handler);
  }, [onStartEvent]);

  useEffect(() => {
    if (view !== "sheet") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onView("closed"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onView]);

  useEffect(() => {
    if (view === "closed") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [view]);

  const toggle = () => { if (timer) void mutate(paused ? "resume" : "pause"); };

  const stop = async () => {
    if (!timer) return;
    const result = await mutate("pause");
    if (!result?.timer) return;
    const windowed = initialEntryWindow(result.timer.startedAt, elapsedMs(result.timer, adjustedNow(Date.now(), result.skew)));
    setDraftSync(() => ({
      startedAt: windowed.startedAt,
      endedAt: windowed.endedAt,
      taskId: "",
      billable: false,
      hourlyRateMinor: readHourlyRate(),
      description: "",
    }));
    setStopKey(k => k + 1);
    onView("stopping");
  };

  const discard = async () => {
    if (!window.confirm("¿Descartar el temporizador? El tiempo no se va a guardar.")) return;
    const result = await mutate("discard");
    if (result) { setDraftSync(() => null); onView("closed"); }
  };

  const save = async () => {
    const current = draftRef.current;
    if (!current) return;
    const durationMs = current.endedAt - current.startedAt;
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS || current.endedAt <= current.startedAt) {
      onError("El tiempo del registro no es válido");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/time-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          startedAt: current.startedAt,
          endedAt: current.endedAt,
          durationMs,
          taskId: current.taskId || null,
          billable: current.billable,
          hourlyRateMinor: current.hourlyRateMinor,
          description: current.description,
          fromTimer: true,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; id?: string };
      if (!response.ok || typeof body.id !== "string") {
        onError(body.error || "No se pudo guardar el registro");
        return;
      }
      writeHourlyRate(current.hourlyRateMinor);
      const task = tasks.find(t => t.id === current.taskId);
      onEntry({
        id: body.id,
        taskId: current.taskId || null,
        taskTitle: task ? String(task.title ?? "") : null,
        startedAt: current.startedAt,
        endedAt: current.endedAt,
        durationMs,
        billable: current.billable ? 1 : 0,
        hourlyRateMinor: current.hourlyRateMinor,
        amountMinor: entryAmountMinor(durationMs, current.hourlyRateMinor, current.billable),
        currency: "ARS",
        description: current.description.trim() || null,
        createdAt: Date.now(),
      });
      onTimer(null, 0);
      setDraftSync(() => null);
      onView("closed");
      onNotice("Registro guardado");
    } catch {
      onError("No se pudo guardar el registro");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openTasks = tasks
    .filter(t => String(t.status ?? "") !== "done")
    .map(t => ({ id: t.id, title: String(t.title ?? "Tarea") }))
    .sort((a, b) => a.title.localeCompare(b.title, "es"));

  return <>
    {timer && view === "closed" && <TimerPill elapsed={elapsed} paused={paused} busy={busy} onOpen={() => onView("sheet")} onToggle={toggle} />}
    {timer && view === "sheet" && <TimerSheet elapsed={elapsed} paused={paused} busy={busy} onMinimize={() => onView("closed")} onToggle={toggle} onStop={() => void stop()} />}
    {timer && view === "stopping" && draft && (
      <TimerStopScreen
        key={stopKey}
        draft={draft}
        tasks={openTasks}
        busy={busy}
        onChange={patch => setDraftSync(d => d ? { ...d, ...patch } : d)}
        onClose={() => onView("closed")}
        onDiscard={() => void discard()}
        onSave={() => void save()}
      />
    )}
  </>;
}

function TimerPill({ elapsed, paused, busy, onOpen, onToggle }: { elapsed: number; paused: boolean; busy: boolean; onOpen: () => void; onToggle: () => void }) {
  const label = paused ? "Reanudar" : "Pausa";
  return <div className="timer-pill">
    <button type="button" className="timer-pill-open" title="Abrir temporizador" aria-label={"Abrir temporizador, " + formatHMS(elapsed)} onClick={onOpen}>
      <span className="timer-pill-time">{formatHMS(elapsed)}</span>
    </button>
    <button type="button" className="timer-pill-toggle" title={label} aria-label={label} disabled={busy} onClick={onToggle}>
      {paused ? <Play size={16} strokeWidth={1.75} aria-hidden="true" /> : <Pause size={16} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  </div>;
}

function TimerSheet({ elapsed, paused, busy, onMinimize, onToggle, onStop }: {
  elapsed: number; paused: boolean; busy: boolean; onMinimize: () => void; onToggle: () => void; onStop: () => void;
}) {
  const label = paused ? "Reanudar" : "Pausa";
  return <div className="timer-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onMinimize(); }}>
    <section className="timer-sheet" role="dialog" aria-modal="true" aria-label="Temporizador" onPointerDown={event => event.stopPropagation()}>
      <div className="timer-sheet-top">
        <button type="button" className="timer-icon" title="Minimizar" aria-label="Minimizar" onClick={onMinimize}><ChevronDown size={22} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <p className="timer-clock">{formatHMS(elapsed)}</p>
      <div className="timer-actions">
        <button type="button" className="timer-round" title={label} aria-label={label} disabled={busy} onClick={onToggle}>
          {paused ? <Play size={22} strokeWidth={1.75} aria-hidden="true" /> : <Pause size={22} strokeWidth={1.75} aria-hidden="true" />}
          <span>{label}</span>
        </button>
        <button type="button" className="timer-round stop" title="Detener" aria-label="Detener" disabled={busy} onClick={onStop}>
          <Square size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>Detener</span>
        </button>
      </div>
    </section>
  </div>;
}

function TimerStopScreen({ draft, tasks, busy, onChange, onClose, onDiscard, onSave }: {
  draft: Draft;
  tasks: { id: string; title: string }[];
  busy: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const [editingRate, setEditingRate] = useState(false);
  const [rateText, setRateText] = useState("");
  const duration = Math.max(0, draft.endedAt - draft.startedAt);
  const [hh, mm] = formatHM(duration).split(":");
  const commitRate = () => {
    const n = Number(rateText.replace(",", "."));
    setEditingRate(false);
    if (!Number.isFinite(n) || n < 0) return;
    const minor = Math.round(n * 100);
    if (!Number.isSafeInteger(minor) || minor > MAX_HOURLY_RATE_MINOR) return;
    onChange({ hourlyRateMinor: minor });
    writeHourlyRate(minor);
  };
  return <div className="timer-stop" role="dialog" aria-modal="true" aria-label="Registrar tiempo">
    <header className="timer-stop-bar">
      <div className="timer-stop-bar-inner">
        <button type="button" className="timer-icon" title="Volver" aria-label="Volver" disabled={busy} onClick={onClose}><X size={22} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="timer-done" title="Listo" aria-label="Listo" disabled={busy} onClick={onSave}>Listo</button>
      </div>
    </header>
    <div className="timer-stop-body">
      <label className="timer-field">Hora de inicio
        <input type="datetime-local" value={epochToLocalInput(draft.startedAt)} disabled={busy} aria-label="Hora de inicio" onChange={event => {
          const next = applyStartInput(draft.endedAt, event.target.value);
          if (next) onChange(next);
        }} />
      </label>
      <label className="timer-field">Hora de finalización
        <input type="datetime-local" value={epochToLocalInput(draft.endedAt)} disabled={busy} aria-label="Hora de finalización" onChange={event => {
          const next = applyEndInput(draft.startedAt, event.target.value);
          if (next != null) onChange({ endedAt: next });
        }} />
      </label>
      <div className="timer-duration" aria-label={"Duración " + hh + " horas " + mm + " minutos"}>
        <div><strong>{hh}</strong><small>Horas</small></div>
        <span className="timer-duration-colon" aria-hidden="true">:</span>
        <div><strong>{mm}</strong><small>Minutos</small></div>
      </div>
      <div className="timer-nudges">
        <button type="button" className="timer-nudge" title="−5 min" aria-label="−5 min" disabled={busy} onClick={() => onChange({ endedAt: nudgeEnd(draft.startedAt, draft.endedAt, -NUDGE_MS) })}>−5<span>min</span></button>
        <button type="button" className="timer-round-pill" title="Redondear tiempo" aria-label="Redondear tiempo" disabled={busy} onClick={() => onChange({ endedAt: roundUpEnd(draft.startedAt, draft.endedAt) })}>Redondear tiempo</button>
        <button type="button" className="timer-nudge" title="+5 min" aria-label="+5 min" disabled={busy} onClick={() => onChange({ endedAt: nudgeEnd(draft.startedAt, draft.endedAt, NUDGE_MS) })}>+5<span>min</span></button>
      </div>
      <label className="timer-field">Asociar a una tarea
        <select value={draft.taskId} disabled={busy} aria-label="Asociar a una tarea" onChange={event => onChange({ taskId: event.target.value })}>
          <option value="">Sin tarea</option>
          {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>
      <div className="timer-billable">
        <button type="button" role="switch" aria-checked={draft.billable} className={"timer-switch" + (draft.billable ? " on" : "")} title="Facturable" aria-label="Facturable" disabled={busy} onClick={() => onChange({ billable: !draft.billable })}><span /></button>
        <div>
          <strong>Facturable</strong>
          <p className="timer-rate">Tarifa por hora:{" "}
            {editingRate
              ? <input type="number" inputMode="decimal" min={0} max={MAX_HOURLY_RATE_MINOR / 100} step="0.01" autoFocus aria-label="Tarifa por hora" value={rateText} onChange={event => setRateText(event.target.value)} onBlur={commitRate} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitRate(); } }} />
              : <span>{formatARS(draft.hourlyRateMinor)}</span>}
            {" · "}
            <button type="button" className="timer-link" title="Editar tarifa" aria-label="Editar tarifa" disabled={busy} onClick={() => { if (editingRate) commitRate(); else { setRateText((draft.hourlyRateMinor / 100).toFixed(2)); setEditingRate(true); } }}>Editar</button>
          </p>
          {draft.billable && <p className="timer-importe">Importe: {formatARS(entryAmountMinor(duration, draft.hourlyRateMinor, true))}</p>}
        </div>
      </div>
      <label className="timer-field">Descripción
        <textarea rows={3} maxLength={2000} placeholder="Opcional" value={draft.description} disabled={busy} aria-label="Descripción" onChange={event => onChange({ description: event.target.value })} />
      </label>
      <button type="button" className="timer-discard" title="Descartar" aria-label="Descartar" disabled={busy} onClick={onDiscard}>Descartar</button>
    </div>
  </div>;
}

export function TimeEntriesPanel({ entries, onDeleted, onError }: {
  entries: TimeEntry[];
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const totals = useMemo(() => {
    let ms = 0, billable = 0;
    for (const entry of entries) {
      ms += Number(entry.durationMs) || 0;
      if (entry.billable && (entry.currency || "ARS") === "ARS") billable += Number(entry.amountMinor) || 0;
    }
    return { ms, billable };
  }, [entries]);
  const recent = useMemo(() => [...entries].sort((a, b) => b.startedAt - a.startedAt || b.createdAt - a.createdAt).slice(0, 5), [entries]);
  const remove = async (entry: TimeEntry) => {
    if (pending) return;
    if (!window.confirm("¿Eliminar este registro de tiempo? Esta acción no se puede deshacer.")) return;
    setPending(entry.id);
    try {
      const response = await fetch("/api/time-entries/" + encodeURIComponent(entry.id), { method: "DELETE", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { onError(body.error || "No se pudo eliminar el registro"); return; }
      onDeleted(entry.id);
    } catch {
      onError("No se pudo eliminar el registro");
    } finally {
      setPending(null);
    }
  };
  return <section className="panel time-panel" aria-label="Tiempo registrado">
    <div className="panel-title"><h2 className="time-panel-title"><Clock size={16} strokeWidth={1.75} aria-hidden="true" /> Tiempo registrado</h2></div>
    <div className="time-stats">
      <div title="Suma del tiempo registrado"><small>Total</small><strong>{formatTracked(totals.ms)}</strong></div>
      <div title="Suma facturable en ARS"><small>Facturable</small><strong>{formatARS(totals.billable)}</strong></div>
    </div>
    {recent.length === 0
      ? <p className="empty-copy">Todavía no hay tiempo registrado.</p>
      : recent.map(entry => {
        const label = entry.taskTitle || entry.description || "Sin descripción";
        return <div className="time-entry" key={entry.id}>
          <div className="time-entry-main">
            <strong title={label}>{label}</strong>
            <small>{formatWhen(entry.startedAt)} · {formatTracked(entry.durationMs)}{entry.billable ? " · " + formatARS(Number(entry.amountMinor) || 0) : ""}</small>
          </div>
          <button type="button" className="time-entry-delete" title="Eliminar" aria-label="Eliminar registro de tiempo" disabled={pending === entry.id} onClick={() => void remove(entry)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>;
      })}
  </section>;
}
