"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";

export type AgendaItem = Record<string, string | number | boolean | null | undefined> & { id: string };
type Tab = "general" | "calendar" | "list";
type Kind = "task" | "event" | "note";
type Entry = { key: string; kind: Kind; day: string; time: string; title: string; sub: string; source: AgendaItem };

const KIND_LABEL: Record<Kind, string> = { task: "Tarea", event: "Evento", note: "Nota" };
const pad = (n: number) => String(n).padStart(2, "0");
const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

export default function Agenda({ tasks, activities, onToggleTask, onEditTask, onEditActivity, onDeleteTask, onDeleteActivity, taskPending }: {
  tasks: AgendaItem[]; activities: AgendaItem[];
  onToggleTask: (t: AgendaItem) => void; onEditTask: (t: AgendaItem) => void; onEditActivity: (a: AgendaItem) => void;
  onDeleteTask: (t: AgendaItem) => void; onDeleteActivity: (a: AgendaItem) => void; taskPending?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("general");
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [selected, setSelected] = useState(() => toDay(new Date()));
  const [reading, setReading] = useState<AgendaItem | null>(null);
  const today = toDay(new Date());

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

  const renderRow = (e: Entry) => {
    const done = e.kind === "task" && e.source.status === "done";
    return <div className={"agenda-row kind-" + e.kind + (done ? " is-done" : "")}>
      {e.kind === "task"
        ? <button type="button" className="checklist-toggle" aria-label={done ? "Marcar pendiente" : "Marcar como hecha"} title={done ? "Marcar pendiente" : "Marcar como hecha"} aria-pressed={done} disabled={taskPending === e.source.id} onClick={() => onToggleTask(e.source)}>{done ? <Check size={16} /> : null}</button>
        : <span className={"agenda-dot kind-" + e.kind} aria-hidden="true" />}
      <button type="button" className="agenda-main" title={e.kind === "note" ? "Abrir nota" : "Editar"} onClick={() => e.kind === "note" ? setReading(e.source) : e.kind === "task" ? onEditTask(e.source) : onEditActivity(e.source)}>
        <strong>{e.title}</strong>
        <small>{KIND_LABEL[e.kind]}{e.time ? " · " + e.time : ""}{e.sub ? " · " + e.sub : ""}</small>
      </button>
    </div>;
  }

  const sortAsc = (a: Entry, b: Entry) => (a.day + a.time).localeCompare(b.day + b.time);
  const overdue = entries.filter(e => isOpenTask(e) && e.day && e.day < today).sort(sortAsc);
  const todayList = (byDay.get(today) || []).filter(e => e.kind !== "task" || e.source.status !== "cancelled").sort(sortAsc);
  const upcoming = entries.filter(e => e.day > today && (e.kind !== "task" || isOpenTask(e))).sort(sortAsc).slice(0, 30);
  const undated = entries.filter(e => e.kind === "task" && !e.day && isOpenTask(e));

  const renderGroup = (title: string, list: Entry[]) => {
    if (!list.length) return null;
    return <section className="panel agenda-group"><h3>{title}</h3>{list.map(e => <div key={e.key} className="agenda-row-wrap">{renderRow(e)}</div>)}</section>;
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month.getFullYear()}-${pad(month.getMonth() + 1)}-${pad(i + 1)}`)];

  const listEntries = entries.filter(e => filter === "all" || e.kind === filter).sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time));
  const empty = entries.length === 0;

  return <div className="agenda">
    <div className="segmented-field agenda-tabs" role="tablist" aria-label="Vista de agenda">
      {([["general", "General"], ["calendar", "Calendario"], ["list", "Lista"]] as [Tab, string][]).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>{label}</button>)}
    </div>

    {tab === "general" && <>
      {empty && <div className="panel"><p className="empty-copy">Todavía no hay tareas, eventos ni notas. Usá el + para agregar la primera.</p></div>}
      {renderGroup("Atrasadas", overdue)}
      {renderGroup("Hoy", todayList)}
      {renderGroup("Próximo", upcoming)}
      {renderGroup("Sin fecha", undated)}
      {!empty && !overdue.length && !todayList.length && !upcoming.length && !undated.length && <div className="panel"><p className="empty-copy">Nada pendiente. Revisá el calendario o la lista para ver lo anterior.</p></div>}
    </>}

    {tab === "calendar" && <>
      <section className="panel calendar">
        <div className="calendar-head">
          <button type="button" className="icon-button" aria-label="Mes anterior" title="Mes anterior" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
          <strong>{month.toLocaleDateString("es-AR", { month: "long", year: "numeric" })}</strong>
          <button type="button" className="icon-button" aria-label="Mes siguiente" title="Mes siguiente" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
        </div>
        <div className="calendar-grid" role="grid">
          {["L", "M", "X", "J", "V", "S", "D"].map((d, i) => <span key={i} className="calendar-dow" aria-hidden="true">{d}</span>)}
          {cells.map((day, i) => {
            if (!day) return <span key={"e" + i} />;
            const list = byDay.get(day) || [];
            const kinds = new Set(list.map(e => e.kind));
            return <button key={day} type="button" className={"calendar-day" + (day === today ? " is-today" : "") + (day === selected ? " is-selected" : "")} aria-pressed={day === selected} aria-label={dayLabel(day) + (list.length ? ", " + list.length + " registros" : "")} onClick={() => setSelected(day)}>
              <span>{Number(day.slice(8))}</span>
              <span className="calendar-dots" aria-hidden="true">{(["task", "event", "note"] as Kind[]).filter(k => kinds.has(k)).map(k => <i key={k} className={"agenda-dot kind-" + k} />)}</span>
            </button>;
          })}
        </div>
        <div className="calendar-legend" aria-hidden="true"><span><i className="agenda-dot kind-task" />Tarea</span><span><i className="agenda-dot kind-event" />Evento</span><span><i className="agenda-dot kind-note" />Nota</span></div>
      </section>
      <section className="panel agenda-group"><h3>{dayLabel(selected)}</h3>
        {(byDay.get(selected) || []).sort(sortAsc).map(e => <div key={e.key} className="agenda-row-wrap">{renderRow(e)}</div>)}
        {!(byDay.get(selected) || []).length && <p className="empty-copy">Sin registros este día.</p>}
      </section>
    </>}

    {tab === "list" && <>
      <div className="segmented-field agenda-filter" role="group" aria-label="Filtrar por tipo">
        {([["all", "Todo"], ["task", "Tareas"], ["event", "Eventos"], ["note", "Notas"]] as ["all" | Kind, string][]).map(([id, label]) =>
          <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "selected" : ""} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <section className="panel agenda-group">
        {listEntries.map(e => <div key={e.key} className="agenda-list-item">{renderRow(e)}<small className="agenda-when">{e.day ? new Date(e.day + "T12:00:00").toLocaleDateString("es-AR") : "Sin fecha"}</small>
          <span className="row-actions"><button type="button" onClick={() => e.kind === "task" ? onDeleteTask(e.source) : onDeleteActivity(e.source)} aria-label="Eliminar" title="Eliminar">Eliminar</button></span></div>)}
        {!listEntries.length && <p className="empty-copy">No hay registros de este tipo.</p>}
      </section>
    </>}

    {reading && <div className="modal-backdrop note-reader-backdrop" role="presentation">
      <section className="note-reader" role="dialog" aria-modal="true" aria-label={String(reading.title)}>
        <header>
          <div><h2>{String(reading.title)}</h2><small>{new Date(String(reading.occurredAt).replace(" ", "T")).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" })}{reading.contactNames ? " · " + String(reading.contactNames) : ""}</small></div>
          <div className="note-reader-actions">
            <button type="button" className="secondary-button compact" onClick={() => { const a = reading; setReading(null); onEditActivity(a); }}><Maximize2 size={14} /> Editar</button>
            <button type="button" className="icon-button" aria-label="Cerrar" title="Cerrar" onClick={() => setReading(null)}>×</button>
          </div>
        </header>
        {reading.body ? <Markdown source={String(reading.body)} /> : <p className="empty-copy">Nota vacía.</p>}
      </section>
    </div>}
  </div>;
}
