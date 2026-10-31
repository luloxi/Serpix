"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CalendarClock, Check, ChevronLeft, ChevronRight, Clock, Maximize2, NotebookPen } from "lucide-react";
import MonthHeading from "@/app/month-heading";
import { dayChip, shortDate, todayBA } from "@/lib/agenda-dates";
import type { NavState } from "@/lib/nav";
import { toneClass } from "@/lib/palette";
import { formatTracked } from "@/lib/timer";

export type AgendaItem = Record<string, string | number | boolean | null | undefined> & { id: string };
type Tab = "general" | "calendar" | "list";
type Kind = "task" | "event" | "note";
type Entry = { key: string; kind: Kind; day: string; time: string; title: string; sub: string; source: AgendaItem };

const KIND_LABEL: Record<Kind, string> = { task: "Tarea", event: "Evento", note: "Nota" };
const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (day: string) => new Date(day + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });

function safeHref(url: string): string | null {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); const href = lm ? safeHref(lm[2]) : null;
      out.push(href ? <a key={i++} href={href} target="_blank" rel="noreferrer">{lm![1]}</a> : t);
    } else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null, para: string[] = [], k = 0;
  const flushPara = () => { if (para.length) { blocks.push(<p key={k++}>{inline(para.join(" "))}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>);
    blocks.push(list.ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>); list = null;
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line), ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const L = h[1].length; blocks.push(L === 1 ? <h3 key={k++}>{inline(h[2])}</h3> : L === 2 ? <h4 key={k++}>{inline(h[2])}</h4> : <h5 key={k++}>{inline(h[2])}</h5>); }
    else if (ul || ol) { flushPara(); const ordered = !!ol; if (list && list.ordered !== ordered) flushList(); if (!list) list = { ordered, items: [] }; list.items.push((ul || ol)![1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return <div className="markdown">{blocks}</div>;
}

export default function Agenda({ tasks, activities, onToggleTask, onEditTask, onEditActivity, onDeleteTask, onDeleteActivity, taskPending, timeByTask = {}, tab, filter, month, day, noteId, noteOpen, onNav, onOpenNote, onCloseNote }: {
  tasks: AgendaItem[]; activities: AgendaItem[];
  onToggleTask: (t: AgendaItem) => void; onEditTask: (t: AgendaItem) => void; onEditActivity: (a: AgendaItem) => void;
  onDeleteTask: (t: AgendaItem) => void; onDeleteActivity: (a: AgendaItem) => void; taskPending?: string | null;
  timeByTask?: Record<string, number>;
  tab: Tab;
  filter: "all" | Kind;
  month: string | null;
  day: string | null;
  noteId: string | null;
  noteOpen: boolean;
  onNav: (patch: Partial<NavState>, mode: "push" | "replace") => void;
  onOpenNote: (id: string) => void;
  onCloseNote: () => void;
}) {
  const today = todayBA();
  const monthKey = month ?? today.slice(0, 7);
  const monthDate = new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1);
  const selected = day ?? today;
  const reading = noteOpen && noteId ? activities.find(a => a.id === noteId) ?? null : null;

  const entries = useMemo<Entry[]>(() => {
    const e: Entry[] = [];
    for (const t of tasks) e.push({ key: "t" + t.id, kind: "task", day: String(t.dueDate || ""), time: "", title: String(t.title), sub: String(t.contactName || t.projectName || ""), source: t });
    for (const a of activities) {
      const raw = String(a.occurredAt || "").replace(" ", "T");
      e.push({ key: "a" + a.id, kind: a.kind === "note" ? "note" : "event", day: raw.slice(0, 10), time: raw.slice(11, 16), title: String(a.title), sub: String(a.contactNames || ""), source: a });
    }
    return e;
  }, [tasks, activities]);

  const byDay = useMemo(() => { const m = new Map<string, Entry[]>(); for (const e of entries) if (e.day) m.set(e.day, [...(m.get(e.day) || []), e]); return m; }, [entries]);
  const isOpenTask = (e: Entry) => e.kind === "task" && e.source.status !== "done" && e.source.status !== "cancelled";

  const renderRow = (e: Entry, overdueDate?: string, withTracked = true) => {
    const done = e.kind === "task" && e.source.status === "done";
    const tracked = withTracked && e.kind === "task" ? timeByTask[e.source.id] || 0 : 0;
    return <div className={"agenda-row kind-" + e.kind + (e.kind === "task" ? " prio-" + String(e.source.priority || "normal") : "") + (done ? " is-done" : "")}>
      {e.kind === "task"
        ? <button type="button" className="checklist-toggle" aria-label={done ? "Marcar pendiente" : "Marcar como hecha"} title={done ? "Marcar pendiente" : "Marcar como hecha"} aria-pressed={done} disabled={taskPending === e.source.id} onClick={() => onToggleTask(e.source)}>{done ? <Check size={16} /> : null}</button>
        : <span className={"agenda-kind kind-" + e.kind} title={KIND_LABEL[e.kind]} role="img" aria-label={KIND_LABEL[e.kind]}>{e.kind === "event" ? <CalendarClock size={17} /> : <NotebookPen size={17} />}</span>}
      <button type="button" className="agenda-main" title={e.kind === "note" ? "Abrir nota" : "Editar"} onClick={() => e.kind === "note" ? onOpenNote(e.source.id) : e.kind === "task" ? onEditTask(e.source) : onEditActivity(e.source)}>
        <strong>{e.title}</strong>
        {e.sub && <small>{e.sub}</small>}
      </button>
      {tracked > 0 && <span className="agenda-tracked" title="Tiempo registrado en esta tarea" aria-label={"Tiempo registrado en esta tarea: " + formatTracked(tracked)}><Clock size={13} strokeWidth={1.75} aria-hidden="true" />{formatTracked(tracked)}</span>}
      {e.time && <time className="agenda-time" title="Hora">{e.time}</time>}
      {overdueDate && <time className="agenda-time is-overdue" title="Venció el">{overdueDate}</time>}
    </div>;
  }

  const sortAsc = (a: Entry, b: Entry) => (a.day + a.time).localeCompare(b.day + b.time);
  const todayMonth = today.slice(0, 7);
  // Past months shown above "Hoy": the most recent ones first, one more each time the user reaches the top.
  const [pastCount, setPastCount] = useState(2);
  const scrollKeep = useRef<{ h: number; y: number } | null>(null);
  const todayRef = useRef<HTMLHeadingElement>(null);
  const overdueRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  const [away, setAway] = useState<null | "above" | "below">(null);
  const [overdueSeen, setOverdueSeen] = useState(true);

  // Timeline for General and Lista: one chronological line, past + today + future, month once and a heading per day.
  const timeline = (variant: "general" | "list") => {
    const kindOk = (e: Entry) => variant === "list" ? (filter === "all" || e.kind === filter) : e.kind !== "task" || e.source.status !== "cancelled";
    const overdueList = variant === "general" ? entries.filter(e => isOpenTask(e) && e.day && e.day < today).sort(sortAsc) : [];
    const overdueKeys = new Set(overdueList.map(e => e.key));
    const dated = entries.filter(e => e.day && kindOk(e) && !overdueKeys.has(e.key)).sort(sortAsc);
    const months = new Map<string, Map<string, Entry[]>>();
    const add = (day: string, e?: Entry) => {
      const m = day.slice(0, 7);
      if (!months.has(m)) months.set(m, new Map());
      const d = months.get(m)!;
      if (!d.has(day)) d.set(day, []);
      if (e) d.get(day)!.push(e);
    };
    for (const e of dated) add(e.day, e);
    add(today); // "Hoy" always exists: it is the anchor
    const keys = [...months.keys()].sort();
    const pastKeys = keys.filter(k => k < todayMonth);
    const shown = keys.filter(k => k >= todayMonth || pastKeys.slice(-pastCount).includes(k));
    const undatedList = variant === "general" ? entries.filter(e => e.kind === "task" && !e.day && isOpenTask(e)) : entries.filter(e => !e.day && kindOk(e));
    return { overdueList, months, shown, hasMorePast: pastKeys.length > pastCount, undatedList };
  };

  const loadMorePast = useCallback(() => {
    scrollKeep.current = { h: document.documentElement.scrollHeight, y: window.scrollY };
    setPastCount(c => c + 1);
  }, []);
  // Keep what the user is looking at in place when a month is inserted above it.
  useLayoutEffect(() => {
    const k = scrollKeep.current;
    if (!k) return;
    scrollKeep.current = null;
    window.scrollTo({ top: k.y + (document.documentElement.scrollHeight - k.h), behavior: "instant" });
  }, [pastCount]);

  const goToday = useCallback((smooth: boolean) => todayRef.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" }), []);
  // Open positioned on "Hoy" (no animation). Re-runs when switching between General and Lista, not on data refreshes.
  useLayoutEffect(() => {
    if (tab === "calendar") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArmed(false);
    goToday(false);
    const t = window.setTimeout(() => { goToday(false); const arm = () => { setArmed(true); window.removeEventListener("scroll", arm); }; window.addEventListener("scroll", arm, { passive: true }); }, 350);
    return () => window.clearTimeout(t);
  }, [tab, goToday]);
  // "Hoy" button: only when today's heading is off screen (arrow shows which way it is).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "calendar") { setAway(null); return; }
    const el = todayRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([en]) => setAway(en.isIntersecting ? null : en.boundingClientRect.top < 0 ? "above" : "below"), { rootMargin: "-48px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [tab, entries.length, filter]);
  useEffect(() => {
    const el = overdueRef.current;
    if (!el || tab !== "general") { setOverdueSeen(true); return; }
    const io = new IntersectionObserver(([en]) => setOverdueSeen(en.isIntersecting), { rootMargin: "-48px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [tab, entries.length]);
  // Reaching the top loads one more past month (only after the user has scrolled, so opening never cascades).
  useEffect(() => {
    const el = topRef.current;
    if (!el || !armed) return;
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) loadMorePast(); }, { rootMargin: "240px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [armed, pastCount, tab, loadMorePast]);

  const renderTimeline = (variant: "general" | "list") => {
    const t = timeline(variant);
    const list = variant === "list";
    const dayBlock = (day: string, items: Entry[]) => {
      const isToday = day === today, past = day < today;
      return <div key={day} className={"agenda-day-block" + (past ? " is-past" : "")}>
        <h4 ref={isToday ? todayRef : undefined} id={isToday ? "agenda-hoy" : undefined} className={"agenda-day" + (isToday ? " is-today" : "")}>{dayChip(day, today)}</h4>
        {items.length === 0 && isToday && <p className="agenda-nothing">Nada para hoy</p>}
        {items.map(e => list
          ? <div key={e.key} className="agenda-list-item">{renderRow(e)}<span className="row-actions"><button type="button" onClick={() => e.kind === "task" ? onDeleteTask(e.source) : onDeleteActivity(e.source)} aria-label="Eliminar" title="Eliminar">Eliminar</button></span></div>
          : <div key={e.key} className="agenda-row-wrap">{renderRow(e)}</div>)}
      </div>;
    };
    const overdueBlock = t.overdueList.length > 0 && <div ref={overdueRef} className="agenda-overdue-block is-overdue"><h3 className="agenda-overdue-head">Vencidas · {t.overdueList.length}</h3>{t.overdueList.map(e => <div key={e.key} className="agenda-row-wrap">{renderRow(e, shortDate(e.day))}</div>)}</div>;
    return <>
      {t.hasMorePast && <button ref={topRef} type="button" className="agenda-more" title="Cargar el mes anterior" onClick={loadMorePast}>↑ Mes anterior</button>}
      {t.shown.map(mk => {
        const days = [...t.months.get(mk)!.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return <section key={mk} className={"panel agenda-group " + toneClass(mk)}>
          <MonthHeading day={mk + "-01"} sticky />
          {days.map(([day, items]) => day === today ? <div key={day} className="agenda-today-wrap">{overdueBlock}{dayBlock(day, items)}</div> : dayBlock(day, items))}
        </section>;
      })}
      {t.undatedList.length > 0 && <section className="panel agenda-group"><h3>Sin fecha</h3>{t.undatedList.map(e => list
        ? <div key={e.key} className="agenda-list-item">{renderRow(e)}<span className="row-actions"><button type="button" onClick={() => e.kind === "task" ? onDeleteTask(e.source) : onDeleteActivity(e.source)} aria-label="Eliminar" title="Eliminar">Eliminar</button></span></div>
        : <div key={e.key} className="agenda-row-wrap">{renderRow(e)}</div>)}</section>}
      <div className="agenda-spacer" aria-hidden="true" />
    </>;
  };

  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${monthDate.getFullYear()}-${pad(monthDate.getMonth() + 1)}-${pad(i + 1)}`)];

  const empty = entries.length === 0;
  const overdueCount = entries.filter(e => isOpenTask(e) && e.day && e.day < today).length;
  const calAway = tab === "calendar" && (selected !== today || monthKey !== today.slice(0, 7));
  const goCalToday = () => onNav({ month: null, day: null }, "replace");
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const shiftMonth = (n: number) => {
    const next = new Date(monthDate.getFullYear(), monthDate.getMonth() + n, 1);
    const key = `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
    onNav({ month: key === today.slice(0, 7) ? null : key }, "replace");
  };

  return <div className="agenda">
    <div className="segmented-field agenda-tabs" role="tablist" aria-label="Vista de agenda">
      {([["general", "General"], ["calendar", "Calendario"], ["list", "Lista"]] as [Tab, string][]).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => onNav({ agendaTab: id }, "push")}>{label}</button>)}
    </div>

    {tab === "general" && <>
      {empty && <div className="panel"><p className="empty-copy">Todavía no hay tareas, eventos ni notas. Usá el + para agregar la primera.</p></div>}
      {renderTimeline("general")}
    </>}

    {tab === "calendar" && <>
      <section onTouchStart={ev => { swipe.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY }; }} onTouchEnd={ev => { const st = swipe.current; swipe.current = null; if (!st) return; const dx = ev.changedTouches[0].clientX - st.x, dy = ev.changedTouches[0].clientY - st.y; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) shiftMonth(dx < 0 ? 1 : -1); }} className={"panel calendar " + toneClass(monthKey)}>
        <div className="calendar-head">
          <button type="button" className="icon-button" aria-label="Mes anterior" title="Mes anterior" onClick={() => shiftMonth(-1)}><ChevronLeft size={18} /></button>
          <strong className="tone-text">{monthDate.toLocaleDateString("es-AR", { month: "long", year: "numeric" })}</strong>
          <button type="button" className="icon-button" aria-label="Mes siguiente" title="Mes siguiente" onClick={() => shiftMonth(1)}><ChevronRight size={18} /></button>
        </div>
        <div className="calendar-grid" role="grid">
          {["L", "M", "X", "J", "V", "S", "D"].map((d, i) => <span key={i} className="calendar-dow" aria-hidden="true">{d}</span>)}
          {cells.map((day, i) => {
            if (!day) return <span key={"e" + i} />;
            const list = byDay.get(day) || [];
            const kinds = new Set(list.map(e => e.kind));
            return <button key={day} type="button" className={"calendar-day" + (day === today ? " is-today" : "") + (day === selected ? " is-selected" : "")} aria-pressed={day === selected} aria-label={dayLabel(day) + (list.length ? ", " + list.length + " registros" : "")} onClick={() => onNav({ day: day === today ? null : day }, "replace")}>
              <span>{Number(day.slice(8))}</span>
              <span className="calendar-dots" aria-hidden="true">{(["task", "event", "note"] as Kind[]).filter(k => kinds.has(k)).map(k => <i key={k} className={"agenda-dot kind-" + k} />)}</span>
            </button>;
          })}
        </div>
        <div className="calendar-legend" aria-hidden="true"><span><i className="agenda-dot kind-task" />Tarea</span><span><i className="agenda-dot kind-event" />Evento</span><span><i className="agenda-dot kind-note" />Nota</span></div>
      </section>
      <section className={"panel agenda-group " + toneClass(selected)}><h3 className="month-head"><span className="month-text">{dayLabel(selected)}</span></h3>
        {(byDay.get(selected) || []).sort(sortAsc).map(e => <div key={e.key} className="agenda-row-wrap">{renderRow(e, undefined, false)}</div>)}
        {!(byDay.get(selected) || []).length && <p className="empty-copy">Sin registros este día.</p>}
      </section>
    </>}

    {tab === "list" && <>
      <div className="segmented-field agenda-filter" role="group" aria-label="Filtrar por tipo">
        {([["all", "Todo"], ["task", "Tareas"], ["event", "Eventos"], ["note", "Notas"]] as ["all" | Kind, string][]).map(([id, label]) =>
          <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "selected" : ""} onClick={() => onNav({ agendaKind: id }, "replace")}>{label}</button>)}
      </div>
      {renderTimeline("list")}
    </>}

    {(away || calAway || (tab === "general" && overdueCount > 0 && !overdueSeen)) && <div className="agenda-fab">
      {tab === "general" && overdueCount > 0 && !overdueSeen && <button type="button" className="agenda-pill is-overdue" title="Ir a las tareas vencidas" aria-label={overdueCount + " vencidas: ir a verlas"} onClick={() => overdueRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>{overdueCount} vencidas</button>}
      {(away || calAway) && <button type="button" className="agenda-pill" title="Volver a hoy" aria-label="Volver a hoy" onClick={() => tab === "calendar" ? goCalToday() : goToday(true)}>{tab !== "calendar" && (away === "below" ? <ArrowDown size={15} aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />)}Hoy</button>}
    </div>}

    {reading && <div className="modal-backdrop note-reader-backdrop" role="presentation">
      <section className="note-reader" role="dialog" aria-modal="true" aria-label={String(reading.title)}>
        <header>
          <div><h2>{String(reading.title)}</h2><small>{new Date(String(reading.occurredAt).replace(" ", "T")).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" })}{reading.contactNames ? " · " + String(reading.contactNames) : ""}</small></div>
          <div className="note-reader-actions">
            <button type="button" className="secondary-button compact" onClick={() => onEditActivity(reading)}><Maximize2 size={14} /> Editar</button>
            <button type="button" className="icon-button" aria-label="Cerrar" title="Cerrar" onClick={onCloseNote}>×</button>
          </div>
        </header>
        {reading.body ? <Markdown source={String(reading.body)} /> : <p className="empty-copy">Nota vacía.</p>}
      </section>
    </div>}
  </div>;
}
