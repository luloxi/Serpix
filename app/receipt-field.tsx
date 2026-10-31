"use client";

import { useRef, useState } from "react";
import { Camera, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { AI_READ_LABEL, AI_READ_WARNING, MAX_UPLOAD_BYTES, buildReceiptScanForm, scanInfoNote, shrinkImage, type ScanResponse } from "@/lib/receipt-client";

type Props = {
  receiptId: string;
  /** Encrypted accounts choose, per ticket, whether Workers AI may read it in the clear. */
  e2e?: boolean;
  onScanned: (scan: ScanResponse) => void;
  onRemove: () => void;
  onError: (message: string) => void;
};

/** Ticket block of the expense form: take a photo or upload an image/PDF; Workers AI pre-fills the form; the file is kept with the movement. */
export default function ReceiptField({ receiptId, e2e = false, onScanned, onRemove, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "read" | "unread">("idle");
  const [info, setInfo] = useState("");
  const [readWithAi, setReadWithAi] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (cameraRef.current) cameraRef.current.value = "";
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const body = isPdf ? file : await shrinkImage(file);
      if (body.size > MAX_UPLOAD_BYTES) throw new Error("El archivo pesa demasiado (máx. 1,4 MB).");
      const form = buildReceiptScanForm({ file: body, filename: isPdf ? "ticket.pdf" : "ticket.jpg", ai: e2e && readWithAi });
      const response = await fetch("/api/receipts/scan", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as Partial<ScanResponse> & { error?: string };
      if (!response.ok || !data.receiptId) throw new Error(data.error || "No se pudo subir el ticket");
      setInfo(scanInfoNote(data));
      setStatus(data.ok ? "read" : "unread");
      onScanned(data as ScanResponse);
    } catch (e) {
      onError(e instanceof Error ? e.message : "No se pudo subir el ticket");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="receipt-field" role="group" aria-label="Ticket">
      <div className="receipt-head">
        <strong><Paperclip size={14} aria-hidden="true" /> Ticket</strong>
        <small role={info ? "status" : undefined}>{busy ? "Leyendo el ticket…" : info ? info : status === "read" ? "Leído: revisá los datos y confirmá." : status === "unread" ? "No pude leerlo: cargalo a mano. El archivo queda adjunto." : receiptId ? "Ticket adjunto." : "Sacá una foto o subí una imagen o PDF y se completa solo."}</small>
      </div>
      {e2e && (
        <label className="e2e-ai">
          <input type="checkbox" checked={readWithAi} disabled={busy} onChange={(event) => setReadWithAi(event.target.checked)} />
          <span>{AI_READ_LABEL}</span>
          <small>{AI_READ_WARNING}</small>
        </label>
      )}
      <div className="receipt-actions">
        <button type="button" className="receipt-btn" disabled={busy} title="Abrir la cámara" onClick={() => cameraRef.current?.click()}><Camera size={16} aria-hidden="true" /> Sacar foto</button>
        <button type="button" className="receipt-btn" disabled={busy} title="Subir imagen o PDF" onClick={() => fileRef.current?.click()}><Upload size={16} aria-hidden="true" /> Subir</button>
        {receiptId && !busy && <a className="receipt-btn" href={"/api/receipts/" + encodeURIComponent(receiptId)} target="_blank" rel="noreferrer" title="Ver el ticket guardado"><FileText size={16} aria-hidden="true" /> Ver</a>}
        {receiptId && !busy && <button type="button" className="receipt-btn danger" title="Quitar el ticket" onClick={() => { setStatus("idle"); setInfo(""); onRemove(); }}><Trash2 size={16} aria-hidden="true" /> Quitar</button>}
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(e) => void pick(e.target.files?.[0])} />
    </div>
  );
}
