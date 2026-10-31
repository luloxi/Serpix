"use client";

import { Fragment, useMemo, useState } from "react";
import MonthHeading from "@/app/month-heading";
import { Archive, ArchiveRestore, Mail, MailOpen, Reply, UserCheck, UserPlus, Inbox } from "lucide-react";

export type Inquiry = { id: string; name: string; email: string; message: string; budgetJson: string | null; refCode: string | null; status: "new" | "read" | "archived"; contactId: string | null; createdAt: number };
type Filter = "new" | "all" | "archived";

const fmt = (ts: number) => {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return `hoy ${time}`;
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" }).replace(".", "") + ` ${time}`;
};
const monthKey = (ts: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Buenos_Aires" }).format(new Date(ts)).slice(0, 7);
const budgetChip = (json: string | null) => {
  if (!json) return null;
  try {
    const b = JSON.parse(json) as { mode?: string; hours?: number; total?: number };
    if (typeof b.total !== "number") return null;
    return `US$ ${Math.round(b.total).toLocaleString("en-US")}${b.hours ? ` · ${b.hours}h` : ""}${b.mode === "hourly" ? " · por hora" : ""}`;
  } catch { return null; }
};

export default function Inquiries({ items, openId, onOpenChange, onAction, onViewContact }: { items: Inquiry[]; openId: string | null; onOpenChange: (id: string | null) => void; onAction: (id: string, action: "read" | "unread" | "archive" | "unarchive" | "convert") => Promise<void>; onViewContact: () => void }) {
  const [filter, setFilter] = useState<Filter>("new");
  const [busy, setBusy] = useState<string | null>(null);
  const unread = items.filter(i => i.status === "new").length;
  const shown = useMemo(() => items.filter(i => i.id === openId && filter !== "archived" && i.status !== "archived" ? true : (filter === "new" ? i.status === "new" : filter === "archived" ? i.status === "archived" : i.status !== "archived")), [items, filter, openId]);
  const run = async (id: string, action: Parameters<typeof onAction>[1]) => { setBusy(id); try { await onAction(id, action); } finally { setBusy(null); } };
  const toggle = (i: Inquiry) => { const next = openId === i.id ? null : i.id; onOpenChange(next); if (next && i.status === "new") void run(i.id, "read"); };
  const tabs: [Filter, string, string][] = [["new", `Nuevas${unread ? ` (${unread})` : ""}`, "Sin leer"], ["all", "Todas", "Todas menos archivadas"], ["archived", "Archivadas", "Solicitudes archivadas"]];
  return <div className="inq">
    <div className="segmented-field inq-filter" role="group" aria-label="Filtrar solicitudes">{tabs.map(([id, label, tip]) => <button type="button" key={id} title={tip} className={filter === id ? "selected" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
    {shown.length === 0 ? <div className="panel inq-empty"><Inbox size={22} aria-hidden="true" /><p className="empty-copy">{filter === "new" ? "No hay solicitudes sin leer." : filter === "archived" ? "No hay solicitudes archivadas." : "Todavía no llegó ninguna solicitud desde el portfolio."}</p></div> : <div className="inq-list">
      {shown.map((i, idx) => {
        const mk = monthKey(i.createdAt), newMonth = idx === 0 || monthKey(shown[idx - 1].createdAt) !== mk;
        const isOpen = openId === i.id, chip = budgetChip(i.budgetJson), disabled = busy === i.id;
        return <Fragment key={i.id}>{newMonth && <MonthHeading day={mk + "-01"} loose />}<article id={"inq-" + i.id} className={"panel inq-card " + (i.status === "new" ? "unread " : "") + (isOpen ? "open" : "")}>
          <button type="button" className="inq-head" aria-expanded={isOpen} title={isOpen ? "Cerrar" : "Abrir"} onClick={() => toggle(i)}>
            <span className="inq-dot" aria-hidden="true" title={i.status === "new" ? "Sin leer" : ""} />
            <span className="inq-main"><strong>{i.name}</strong><small>{i.message.replace(/\s+/g, " ")}</small></span>
            <time className="inq-date" dateTime={new Date(i.createdAt).toISOString()}>{fmt(i.createdAt)}</time>
          </button>
          {isOpen && <div className="inq-body">
            <p className="inq-meta"><a href={"mailto:" + i.email} title="Escribir a este mail">{i.email}</a>{chip && <span className="inq-chip" title="Presupuesto calculado por el visitante">{chip}</span>}{i.refCode && <span className="inq-chip" title="Código de referido">ref {i.refCode}</span>}</p>
            <p className="inq-text">{i.message}</p>
            <div className="inq-actions">
              <a className="inq-btn primary" href={"mailto:" + i.email + "?subject=" + encodeURIComponent("Re: tu mensaje en lulox.com.ar")} title="Responder por mail" aria-label="Responder por mail"><Reply size={16} aria-hidden="true" /><span>Responder</span></a>
              {i.contactId ? <button type="button" className="inq-btn" title="Ya es un contacto: ver contactos" aria-label="Ver contacto" onClick={onViewContact}><UserCheck size={16} aria-hidden="true" /><span>Contacto</span></button> : <button type="button" className="inq-btn" disabled={disabled} title="Convertir en contacto (crea uno nuevo)" aria-label="Convertir en contacto" onClick={() => void run(i.id, "convert")}><UserPlus size={16} aria-hidden="true" /><span>Convertir en contacto</span></button>}
              {i.status === "read" && <button type="button" className="inq-btn icon" disabled={disabled} title="Marcar como no leída" aria-label="Marcar como no leída" onClick={() => void run(i.id, "unread")}><Mail size={16} aria-hidden="true" /></button>}
              {i.status === "new" && <button type="button" className="inq-btn icon" disabled={disabled} title="Marcar como leída" aria-label="Marcar como leída" onClick={() => void run(i.id, "read")}><MailOpen size={16} aria-hidden="true" /></button>}
              {i.status === "archived" ? <button type="button" className="inq-btn icon" disabled={disabled} title="Desarchivar" aria-label="Desarchivar" onClick={() => void run(i.id, "unarchive")}><ArchiveRestore size={16} aria-hidden="true" /></button> : <button type="button" className="inq-btn icon" disabled={disabled} title="Archivar" aria-label="Archivar" onClick={() => void run(i.id, "archive")}><Archive size={16} aria-hidden="true" /></button>}
            </div>
          </div>}
        </article></Fragment>;
      })}
    </div>}
  </div>;
}
