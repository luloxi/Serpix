"use client";

import { useState } from "react";
import { Pause, Play, Repeat, Square } from "lucide-react";
import { FREQUENCY_LABEL, type Frequency } from "@/lib/recurring";

export type RecurringRule = {
  id: string;
  kind: "income" | "expense";
  amountMinor: number;
  category: string;
  description: string | null;
  frequency: Frequency;
  anchorDate: string;
  endDate: string | null;
  status: "active" | "paused" | "ended";
  accountId: string;
  accountName: string;
  currency: string;
  nextDate: string | null;
};

const money = (minor: number, currency: string) => new Intl.NumberFormat("es-AR", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
const day = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("es-AR");
const STATUS_LABEL = { active: "Activa", paused: "Pausada", ended: "Terminada" } as const;

/** "Repetir" block of the movement form (new movements, or existing ones that are not recurring yet). */
export function RecurrenceField({ frequency, endDate, onChange }: { frequency: string; endDate: string; onChange: (patch: { recurrence?: string; recurrenceEnd?: string }) => void }) {
  const options: { value: string; label: string }[] = [{ value: "none", label: "No" }, { value: "weekly", label: "Semanal" }, { value: "monthly", label: "Mensual" }, { value: "yearly", label: "Anual" }];
  const current = frequency || "none";
  return (
    <div className="recurrence-field" role="group" aria-label="Repetir">
      <span className="field-label"><Repeat size={14} aria-hidden="true" /> Repetir</span>
      <span className="segmented-field" role="group" aria-label="Frecuencia">
        {options.map((o) => <button type="button" key={o.value} className={current === o.value ? "selected" : ""} aria-pressed={current === o.value} onClick={() => onChange({ recurrence: o.value })}>{o.label}</button>)}
      </span>
      {current !== "none" && (
        <label className="recurrence-end">Hasta (opcional)
          <input type="date" value={endDate} onChange={(e) => onChange({ recurrenceEnd: e.target.value })} />
        </label>
      )}
      {current !== "none" && <small className="recurrence-hint">Se repite el mismo día que la fecha elegida arriba ({current === "weekly" ? "cada semana" : current === "monthly" ? "cada mes; si el mes es más corto, el último día" : "cada año"}). Se genera solo, una vez por período.</small>}
    </div>
  );
}

/** Badge shown on movements created by a rule. */
export function RecurringBadge() {
  return <span className="tag recurring-badge" title="Movimiento recurrente" aria-label="Movimiento recurrente"><Repeat size={11} aria-hidden="true" /> Recurrente</span>;
}

type PanelProps = {
  rules: RecurringRule[];
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onEdit: (rule: RecurringRule) => void;
};

export function RecurringPanel({ rules, onChanged, onError, onNotice, onEdit }: PanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (rule: RecurringRule, method: "PATCH" | "DELETE", body?: Record<string, unknown>, ok?: string) => {
    if (busy) return;
    setBusy(rule.id);
    try {
      const response = await fetch("/api/recurring/" + encodeURIComponent(rule.id), { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "No se pudo actualizar");
      if (ok) onNotice(ok);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "No se pudo actualizar");
    } finally {
      setBusy(null);
    }
  };
  if (rules.length === 0) return null;
  return (
    <section className="panel recurring-panel" aria-label="Movimientos recurrentes">
      <div className="panel-title"><h2><Repeat size={15} aria-hidden="true" /> Recurrentes</h2></div>
      {rules.map((r) => (
        <div className={"list-line recurring-line is-" + r.status} key={r.id}>
          <span className={"money-sign " + r.kind}>{r.kind === "income" ? "+" : "−"}</span>
          <div>
            <strong>{r.category}</strong>
            <small>
              {FREQUENCY_LABEL[r.frequency]} · {r.accountName}
              {r.status === "active" && r.nextDate ? " · próximo " + day(r.nextDate) : ""}
              {r.endDate ? " · hasta " + day(r.endDate) : ""}
            </small>
          </div>
          <span className={"tag recurring-status " + r.status}>{STATUS_LABEL[r.status]}</span>
          <b className={r.kind === "income" ? "positive" : "negative"}>{money(r.amountMinor, r.currency)}</b>
          <div className="row-actions">
            {r.status === "active" && <button type="button" disabled={busy === r.id} title="Pausar: no se generan movimientos hasta reanudar" aria-label="Pausar" onClick={() => void call(r, "PATCH", { action: "pause" }, "Regla pausada")}><Pause size={13} aria-hidden="true" /> Pausar</button>}
            {r.status === "paused" && <button type="button" disabled={busy === r.id} title="Reanudar desde hoy (no se cargan los períodos pausados)" aria-label="Reanudar" onClick={() => void call(r, "PATCH", { action: "resume" }, "Regla reanudada")}><Play size={13} aria-hidden="true" /> Reanudar</button>}
            {r.status !== "ended" && <button type="button" disabled={busy === r.id} title="Editar importe, categoría, cuenta o fecha de fin" aria-label="Editar" onClick={() => onEdit(r)}>Editar</button>}
            {r.status !== "ended" && <button type="button" disabled={busy === r.id} title="Terminar: no se generan más movimientos (los ya creados se conservan)" aria-label="Terminar" onClick={() => { if (window.confirm("¿Terminar esta regla? Los movimientos ya creados se conservan.")) void call(r, "PATCH", { action: "end" }, "Regla terminada"); }}><Square size={12} aria-hidden="true" /> Terminar</button>}
            {r.status === "ended" && <button type="button" disabled={busy === r.id} title="Eliminar la regla (los movimientos ya creados se conservan)" aria-label="Eliminar regla" onClick={() => { if (window.confirm("¿Eliminar la regla? Los movimientos ya creados se conservan.")) void call(r, "DELETE", undefined, "Regla eliminada"); }}>Eliminar</button>}
          </div>
        </div>
      ))}
    </section>
  );
}
