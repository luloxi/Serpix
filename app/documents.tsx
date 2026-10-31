"use client";

// Presupuestos y facturas (comprobantes internos, no fiscales). The hook owns the state and returns three JSX pieces
// so app/workspace.tsx only has to place them: `panel` (Finanzas), `homeAlert` (Resumen) and `modal`.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, Clock, Download, FileText, Plus, ReceiptText, Share2, Trash2 } from "lucide-react";
import { addDays, DEFAULT_DUE_DAYS, displayStatus, formatNumber, lineTotalMinor, STATUS_LABEL, typeLabel, type DocType } from "@/lib/documents";
import { formatMoney, formatDate, fileName } from "@/lib/document-pdf";
import { waNumber } from "@/lib/avatar-client";
import { downloadBlob, renderPdf, sharePdf } from "@/app/document-pdf";

type Doc = {
  id: string; type: DocType; number: number; contactId: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  issueDate: string; dueDate: string | null; currency: "ARS" | "USD"; notes: string | null; status: "draft" | "sent" | "paid" | "void";
  sourceQuoteId: string | null; invoiceId: string | null; transactionId: string | null; paidAt: string | null; totalMinor: number; overdue?: boolean;
};
type ApiItem = { description: string; quantityMilli: number; unitPriceMinor: number; timeEntryId?: string | null };
type Line = { key: string; description: string; qty: string; price: string; timeEntryId: string | null };
type Draft = Omit<Doc, "id" | "number" | "totalMinor" | "overdue" | "contactName" | "contactEmail" | "contactPhone" | "sourceQuoteId" | "invoiceId" | "transactionId" | "paidAt"> & { id: string | null; number: number | null; lines: Line[]; transactionId: string | null; invoiceId: string | null; paidAt: string | null };
type Contact = { id: string; name?: unknown; phone?: unknown; email?: unknown };
type Account = { id: string; name?: unknown; currency?: unknown };
type Importable = { id: string; taskTitle: string | null; startedAt: number; durationMs: number; hourlyRateMinor: number; currency: string; item: ApiItem };

const uid = () => Math.random().toString(36).slice(2, 10);
/** "1.500,50" / "1500.5" / "12" -> number (NaN when it is not a number). */
export function parseDecimal(raw: string): number {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return NaN;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : NaN;
}
const minorToInput = (minor: number) => (minor / 100).toFixed(2).replace(".", ",");
const milliToInput = (milli: number) => String(milli / 1000).replace(".", ",");
const blankLine = (): Line => ({ key: uid(), description: "", qty: "1", price: "", timeEntryId: null });

function lineFromApi(i: ApiItem): Line {
  return { key: uid(), description: i.description, qty: milliToInput(i.quantityMilli), price: minorToInput(i.unitPriceMinor), timeEntryId: i.timeEntryId ?? null };
}
function toApiItems(lines: Line[]): ApiItem[] | string {
  const out: ApiItem[] = [];
  for (const l of lines) {
    if (!l.description.trim() && !l.price.trim()) continue;
    const q = parseDecimal(l.qty), p = parseDecimal(l.price);
    if (!l.description.trim()) return "Falta la descripción de un ítem";
    if (!(q > 0) || !Number.isSafeInteger(Math.round(q * 1000))) return "Cantidad inválida en «" + l.description.trim().slice(0, 30) + "»";
    if (!(p >= 0) || !Number.isSafeInteger(Math.round(p * 100))) return "Precio inválido en «" + l.description.trim().slice(0, 30) + "»";
    out.push({ description: l.description.trim(), quantityMilli: Math.round(q * 1000), unitPriceMinor: Math.round(p * 100), timeEntryId: l.timeEntryId });
  }
  return out.length ? out : "Agregá al menos un ítem";
}

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: T & { error?: string } }> {
  const r = await fetch(path, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  return { ok: r.ok, status: r.status, json };
}

const daysLate = (due: string | null, today: string) => (due ? Math.max(1, Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(due + "T12:00:00Z")) / 86_400_000)) : 0);

export function StatusBadge({ doc, today }: { doc: Pick<Doc, "type" | "status" | "dueDate"> & { invoiceId?: string | null }; today: string }) {
  const s = displayStatus(doc, today);
  const label = doc.type === "quote" && doc.invoiceId && doc.status !== "void" ? "Facturado" : STATUS_LABEL[s];
  return <span className={"doc-badge doc-" + (doc.type === "quote" && doc.invoiceId && doc.status !== "void" ? "billed" : s)}>{label}</span>;
}

export function useDocuments(o: {
  contacts: Contact[]; accounts: Account[]; issuer: { name: string; email: string | null };
  onNotice: (m: string) => void; onError: (m: string) => void; onChanged: () => void;
}): { panel: ReactNode; modal: ReactNode; homeAlert: ReactNode; openNew: (type: DocType) => void; overdueCount: number; open: boolean; close: () => void } {
  const { contacts, accounts, issuer, onNotice, onError, onChanged } = o;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [today, setToday] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [tab, setTab] = useState<DocType>("invoice");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<{ accountId: string; paidAt: string } | null>(null);
  const [importList, setImportList] = useState<{ items: Importable[]; picked: Record<string, boolean> } | null>(null);
  const lastLoad = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ items: Doc[]; today: string }>("/api/documents");
      if (r.ok && Array.isArray(r.json.items)) { setDocs(r.json.items); if (r.json.today) setToday(r.json.today); }
    } catch { /* offline: keep what we have */ }
    lastLoad.current = Date.now();
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible" && Date.now() - lastLoad.current > 1500) void refresh(); };
    document.addEventListener("visibilitychange", again); window.addEventListener("focus", again);
    return () => { document.removeEventListener("visibilitychange", again); window.removeEventListener("focus", again); };
  }, [refresh]);

  const overdue = useMemo(() => docs.filter((d) => d.overdue).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))), [docs]);

  const openNew = useCallback((type: DocType) => {
    setPay(null); setImportList(null);
    setDraft({ id: null, number: null, type, contactId: null, issueDate: today, dueDate: addDays(today, DEFAULT_DUE_DAYS), currency: "ARS", notes: null, status: "draft", lines: [blankLine()], transactionId: null, invoiceId: null, paidAt: null });
  }, [today]);

  const openDoc = useCallback(async (id: string) => {
    setPay(null); setImportList(null);
    const r = await api<Doc & { items: ApiItem[] }>("/api/documents/" + encodeURIComponent(id));
    if (!r.ok) { onError(r.json.error || "No se pudo abrir el comprobante"); return; }
    const d = r.json;
    setDraft({ id: d.id, number: d.number, type: d.type, contactId: d.contactId, issueDate: d.issueDate, dueDate: d.dueDate, currency: d.currency, notes: d.notes, status: d.status, lines: d.items.map(lineFromApi), transactionId: d.transactionId, invoiceId: d.invoiceId, paidAt: d.paidAt });
  }, [onError]);

  const body = (d: Draft, items: ApiItem[]) => ({ type: d.type, contactId: d.contactId, issueDate: d.issueDate, dueDate: d.dueDate || null, currency: d.currency, notes: d.notes, items });
  const closed = draft?.status === "paid" || draft?.status === "void";

  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    const items = toApiItems(draft.lines);
    if (typeof items === "string") { onError(items); return null; }
    setBusy(true);
    try {
      if (!draft.id) {
        const r = await api<{ id: string; number: number }>("/api/documents", { method: "POST", body: JSON.stringify(body(draft, items)) });
        if (!r.ok) { onError(r.json.error || "No se pudo guardar"); return null; }
        onNotice(typeLabel(draft.type) + " " + formatNumber(draft.type, r.json.number) + " guardado");
        await refresh(); await openDoc(r.json.id); return r.json.id;
      }
      const r = await api("/api/documents/" + draft.id, { method: "PATCH", body: JSON.stringify({ action: "save", ...body(draft, items) }) });
      if (!r.ok) { onError(r.json.error || "No se pudo guardar"); return null; }
      onNotice("Guardado"); await refresh(); await openDoc(draft.id); return draft.id;
    } finally { setBusy(false); }
  };

  const patch = async (payload: Record<string, unknown>, okMsg: string, then?: (json: Record<string, unknown>) => void) => {
    if (!draft?.id) return;
    setBusy(true);
    try {
      const r = await api<Record<string, unknown>>("/api/documents/" + draft.id, { method: "PATCH", body: JSON.stringify(payload) });
      if (!r.ok) { onError(r.json.error || "No se pudo completar la acción"); return; }
      onNotice(okMsg); await refresh();
      if (then) then(r.json); else await openDoc(draft.id);
    } finally { setBusy(false); }
  };

  const doPay = () => {
    if (!pay) return;
    void patch({ action: "pay", accountId: pay.accountId, paidAt: pay.paidAt }, "Cobrada: ingreso registrado en Finanzas", () => { setPay(null); onChanged(); void openDoc(draft!.id!); });
  };
  const convert = () => void patch({ action: "convert" }, "Factura creada desde el presupuesto", (j) => { onChanged(); void openDoc(String(j.id)); });
  const remove = async () => {
    if (!draft?.id) return;
    if (!window.confirm("¿Borrar este borrador?")) return;
    setBusy(true);
    try {
      const r = await api("/api/documents/" + draft.id, { method: "DELETE" });
      if (!r.ok) { onError(r.json.error || "No se pudo borrar"); return; }
      onNotice("Borrador borrado"); setDraft(null); await refresh();
    } finally { setBusy(false); }
  };
  const voidDoc = () => { if (window.confirm("¿Anular? Queda en el historial y no se puede reactivar.")) void patch({ action: "status", status: "void" }, "Anulado"); };

  const pdfData = (d: Draft) => {
    const items = toApiItems(d.lines);
    if (typeof items === "string") { onError(items); return null; }
    const c = contacts.find((x) => x.id === d.contactId);
    return { type: d.type, number: d.number ?? 0, status: d.status, issueDate: d.issueDate, dueDate: d.dueDate || null, currency: d.currency, notes: d.notes, paidAt: d.paidAt, contactName: c ? String(c.name) : null, contactEmail: c?.email ? String(c.email) : null, contactPhone: c?.phone ? String(c.phone) : null, items };
  };
  const makePdf = async (mode: "download" | "share") => {
    if (!draft?.id) { onError("Guardá primero el comprobante"); return; }
    const data = pdfData(draft); if (!data) return;
    setBusy(true);
    try {
      const blob = await renderPdf(data, issuer, today);
      if (mode === "download") { downloadBlob(blob, fileName(data)); onNotice("PDF descargado"); }
      else { const r = await sharePdf(blob, data, waNumber(data.contactPhone)); if (r === "whatsapp") onNotice("PDF descargado: adjuntalo en WhatsApp"); }
    } catch { onError("No se pudo generar el PDF"); } finally { setBusy(false); }
  };

  const loadImportables = async () => {
    if (!draft?.contactId) return;
    const r = await api<{ items: Importable[] }>(`/api/documents/time-entries?contactId=${encodeURIComponent(draft.contactId)}&currency=${draft.currency}${draft.id ? "&docId=" + draft.id : ""}`);
    if (!r.ok) { onError("No se pudieron cargar las horas"); return; }
    const have = new Set(draft.lines.map((l) => l.timeEntryId).filter(Boolean));
    const items = (r.json.items || []).filter((i) => !have.has(i.id));
    if (!items.length) { onNotice("No hay horas facturables pendientes de este cliente"); setImportList(null); return; }
    setImportList({ items, picked: Object.fromEntries(items.map((i) => [i.id, true])) });
  };
  const addImported = () => {
    if (!draft || !importList) return;
    const picked = importList.items.filter((i) => importList.picked[i.id]).map((i) => lineFromApi(i.item));
    setDraft({ ...draft, lines: [...draft.lines.filter((l) => l.description.trim() || l.price.trim()), ...picked] });
    setImportList(null);
  };

  const set = (patchDraft: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patchDraft } : d));
  const setLine = (key: string, p: Partial<Line>) => setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) } : d));

  const total = draft ? draft.lines.reduce((s, l) => { const q = parseDecimal(l.qty), p = parseDecimal(l.price); return q > 0 && p >= 0 ? s + lineTotalMinor(Math.round(q * 1000), Math.round(p * 100)) : s; }, 0) : 0;
  const payAccounts = draft ? accounts.filter((a) => a.currency === draft.currency) : [];

  // ---------- Finanzas panel ----------
  const shown = docs.filter((d) => d.type === tab);
  const panel = (
    <section className="panel doc-panel" aria-label="Presupuestos y facturas">
      <div className="panel-title">
        <h2>Facturas y presupuestos <span className="doc-internal" title="Comprobante interno: no es una factura fiscal de ARCA">comprobante interno</span></h2>
        <div className="doc-panel-actions">
          <div className="segmented-field" role="group" aria-label="Tipo">
            {(["invoice", "quote"] as const).map((t) => <button key={t} type="button" className={tab === t ? "selected" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === "invoice" ? "Facturas" : "Presupuestos"}</button>)}
          </div>
          <button type="button" className="text-button" title={"Nuevo " + typeLabel(tab).toLowerCase()} onClick={() => openNew(tab)}>+ Nuevo</button>
        </div>
      </div>
      {shown.length === 0 && <p className="empty-copy" title="Se crean con el botón + o con Nuevo">{tab === "invoice" ? "Sin facturas" : "Sin presupuestos"}</p>}
      {shown.map((d) => (
        <button type="button" key={d.id} className={"doc-row" + (d.overdue ? " is-overdue" : "") + (d.status === "void" ? " is-void" : "")} onClick={() => void openDoc(d.id)} title={d.overdue ? "Vencida hace " + daysLate(d.dueDate, today) + " días, sin cobrar" : "Abrir"}>
          <span className="doc-num">{formatNumber(d.type, d.number)}</span>
          <span className="doc-main"><strong>{d.contactName || "Sin cliente"}</strong><small>{formatDate(d.issueDate)}{d.dueDate ? " · vence " + formatDate(d.dueDate) : ""}</small></span>
          <span className="doc-amount">{formatMoney(d.totalMinor, d.currency)}</span>
          <StatusBadge doc={d} today={today} />
        </button>
      ))}
    </section>
  );

  // ---------- Resumen alert ----------
  const homeAlert = overdue.length === 0 ? null : (
    <section className="panel home-panel doc-alert" aria-label="Cobros atrasados">
      <div className="home-panel-head"><h3><AlertCircle size={16} aria-hidden="true" /> Cobros atrasados</h3></div>
      {overdue.slice(0, 5).map((d) => (
        <button type="button" key={d.id} className="doc-row is-overdue" onClick={() => void openDoc(d.id)} title={"Vencida hace " + daysLate(d.dueDate, today) + " días"}>
          <span className="doc-num">{formatNumber(d.type, d.number)}</span>
          <span className="doc-main"><strong>{d.contactName || "Sin cliente"}</strong><small>vencida hace {daysLate(d.dueDate, today)} d</small></span>
          <span className="doc-amount">{formatMoney(d.totalMinor, d.currency)}</span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      ))}
      {overdue.length > 5 && <p className="empty-copy">y {overdue.length - 5} más en Finanzas</p>}
    </section>
  );

  // ---------- Modal ----------
  const modal = !draft ? null : (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDraft(null); }}>
      <section className="editor-modal doc-modal" role="dialog" aria-modal="true" aria-labelledby="doc-title">
        <div className="panel-title">
          <div>
            <p className="eyebrow" title="No es una factura fiscal de ARCA">COMPROBANTE INTERNO</p>
            <h2 id="doc-title">{draft.id ? typeLabel(draft.type) + " " + formatNumber(draft.type, draft.number ?? 0) : (draft.type === "invoice" ? "Nueva factura" : "Nuevo presupuesto")}{draft.id && <> <StatusBadge doc={{ type: draft.type, status: draft.status, dueDate: draft.dueDate, invoiceId: draft.invoiceId }} today={today} /></>}</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => setDraft(null)} aria-label="Cerrar" title="Cerrar">×</button>
        </div>
        <fieldset className="doc-fields" disabled={closed || busy}>
          <div className="form-grid">
            <label>Cliente
              <select value={draft.contactId ?? ""} onChange={(e) => set({ contactId: e.target.value || null })}>
                <option value="">Sin cliente</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{String(c.name)}</option>)}
              </select>
            </label>
            <label>Moneda
              <select value={draft.currency} onChange={(e) => set({ currency: e.target.value as "ARS" | "USD" })} disabled={draft.lines.some((l) => l.timeEntryId)} title={draft.lines.some((l) => l.timeEntryId) ? "Hay horas importadas: la moneda ya está fija" : undefined}>
                <option value="ARS">ARS</option><option value="USD">USD</option>
              </select>
            </label>
            <label>Fecha<input type="date" value={draft.issueDate} onChange={(e) => set({ issueDate: e.target.value })} required /></label>
            <label>{draft.type === "invoice" ? "Vencimiento" : "Válido hasta"}<input type="date" value={draft.dueDate ?? ""} min={draft.issueDate} onChange={(e) => set({ dueDate: e.target.value || null })} /></label>
          </div>
          <div className="doc-lines" role="group" aria-label="Ítems">
            <div className="doc-lines-head"><span>Ítems</span>
              <span className="doc-lines-tools">
                <button type="button" className="text-button" disabled={!draft.contactId || draft.status === "paid"} title={draft.contactId ? "Importar horas facturables del cliente" : "Elegí un cliente para importar sus horas"} onClick={() => void loadImportables()}><Clock size={12} aria-hidden="true" /> Horas</button>
                <button type="button" className="text-button" title="Agregar ítem" onClick={() => set({ lines: [...draft.lines, blankLine()] })}><Plus size={12} aria-hidden="true" /> Ítem</button>
              </span>
            </div>
            {draft.lines.map((l) => {
              const q = parseDecimal(l.qty), p = parseDecimal(l.price);
              return (
                <div className="doc-line" key={l.key}>
                  <input className="doc-line-desc" placeholder="Descripción" aria-label="Descripción" maxLength={300} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                  <input className="doc-line-qty" inputMode="decimal" aria-label="Cantidad" title="Cantidad" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                  <input className="doc-line-price" inputMode="decimal" placeholder="Precio" aria-label="Precio unitario" title="Precio unitario" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} />
                  <output className="doc-line-total" title="Importe">{q > 0 && p >= 0 ? formatMoney(lineTotalMinor(Math.round(q * 1000), Math.round(p * 100)), draft.currency) : "—"}</output>
                  <button type="button" className="icon-button doc-line-remove" aria-label="Quitar ítem" title="Quitar ítem" disabled={draft.lines.length === 1} onClick={() => set({ lines: draft.lines.filter((x) => x.key !== l.key) })}><Trash2 size={14} aria-hidden="true" /></button>
                </div>
              );
            })}
          </div>
          {importList && (
            <div className="doc-import" role="group" aria-label="Horas para importar">
              {importList.items.map((i) => (
                <label key={i.id}><input type="checkbox" checked={!!importList.picked[i.id]} onChange={(e) => setImportList({ ...importList, picked: { ...importList.picked, [i.id]: e.target.checked } })} />
                  <span>{i.item.description}</span><small>{(i.durationMs / 3_600_000).toFixed(2).replace(".", ",")} h · {formatMoney(i.hourlyRateMinor, i.currency)}/h</small></label>
              ))}
              <div className="doc-import-actions"><button type="button" className="secondary-button" onClick={() => setImportList(null)}>Cancelar</button><button type="button" className="primary-button" onClick={addImported}>Agregar</button></div>
            </div>
          )}
          <label className="doc-notes">Notas<textarea rows={2} maxLength={2000} value={draft.notes ?? ""} placeholder="Forma de pago, condiciones…" onChange={(e) => set({ notes: e.target.value || null })} /></label>
        </fieldset>
        <div className="doc-total"><span>Total {draft.currency}</span><strong>{formatMoney(total, draft.currency)}</strong></div>

        {pay && (
          <div className="doc-pay" role="group" aria-label="Cobrar">
            <label>Cuenta<select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>{payAccounts.map((a) => <option key={a.id} value={a.id}>{String(a.name)}</option>)}</select></label>
            <label>Fecha de cobro<input type="date" value={pay.paidAt} onChange={(e) => setPay({ ...pay, paidAt: e.target.value })} /></label>
            <button type="button" className="secondary-button" onClick={() => setPay(null)}>Cancelar</button>
            <button type="button" className="primary-button" disabled={busy || !pay.accountId || !pay.paidAt} onClick={doPay}>Confirmar cobro</button>
          </div>
        )}
        {draft.status === "paid" && <p className="doc-note"><ReceiptText size={13} aria-hidden="true" /> Cobrada el {draft.paidAt ? formatDate(draft.paidAt) : ""}: el ingreso quedó registrado en Finanzas.</p>}

        <div className="doc-actions">
          {!closed && <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{draft.id ? "Guardar" : "Guardar borrador"}</button>}
          {draft.id && <button type="button" className="secondary-button doc-icon-btn" disabled={busy} title="Descargar PDF" onClick={() => void makePdf("download")}><Download size={14} aria-hidden="true" /> PDF</button>}
          {draft.id && <button type="button" className="secondary-button doc-icon-btn" disabled={busy} title="Compartir (WhatsApp u otras apps)" onClick={() => void makePdf("share")}><Share2 size={14} aria-hidden="true" /> Compartir</button>}
          {draft.id && draft.status === "draft" && <button type="button" className="secondary-button" disabled={busy} title="Marcar como enviada al cliente (no manda ningún mail)" onClick={() => void patch({ action: "status", status: "sent" }, "Marcada como enviada")}>Marcar enviada</button>}
          {draft.id && draft.status === "sent" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void patch({ action: "status", status: "draft" }, "Vuelta a borrador")}>A borrador</button>}
          {draft.id && draft.type === "invoice" && (draft.status === "draft" || draft.status === "sent") && <button type="button" className="primary-button" disabled={busy || payAccounts.length === 0} title={payAccounts.length === 0 ? "Creá una cuenta en " + draft.currency + " para cobrar" : "Registrar el cobro como ingreso en Finanzas"} onClick={() => setPay({ accountId: payAccounts[0]?.id ?? "", paidAt: today })}>Cobrar</button>}
          {draft.id && draft.type === "quote" && draft.status !== "void" && (draft.invoiceId
            ? <button type="button" className="secondary-button doc-icon-btn" disabled={busy} title="Abrir la factura creada" onClick={() => void openDoc(draft.invoiceId!)}><FileText size={14} aria-hidden="true" /> Ver factura</button>
            : <button type="button" className="secondary-button doc-icon-btn" disabled={busy} title="Crear una factura con los mismos ítems" onClick={convert}><ArrowRight size={14} aria-hidden="true" /> Convertir en factura</button>)}
          {draft.id && draft.status === "draft" && <button type="button" className="text-button doc-danger" disabled={busy} onClick={() => void remove()}>Borrar</button>}
          {draft.id && draft.status === "sent" && <button type="button" className="text-button doc-danger" disabled={busy} onClick={voidDoc}>Anular</button>}
        </div>
      </section>
    </div>
  );

  const close = () => { setDraft(null); setPay(null); setImportList(null); };
  return { panel, modal, homeAlert, openNew, overdueCount: overdue.length, open: draft !== null, close };
}
