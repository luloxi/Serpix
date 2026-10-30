"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

type State = "loading" | "unsupported" | "denied" | "off" | "on";
const toKey = (b64: string) => { const p = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4); const bin = atob(p); return Uint8Array.from(bin, c => c.charCodeAt(0)); };

// Profile-menu switch: enables Web Push for THIS device (each phone/computer subscribes on its own).
export default function PushToggle({ onMessage }: { onMessage: (m: string, kind: "ok" | "error") => void }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return setState("off");
      const r = await fetch("/api/push/subscribe?endpoint=" + encodeURIComponent(sub.endpoint), { cache: "no-store" });
      setState(r.ok && (await r.json() as { subscribed: boolean }).subscribed ? "on" : "off");
    } catch { setState("off"); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(t); }, [refresh]);

  const turnOn = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return onMessage("Permiso de notificaciones no concedido.", "error"); }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const k = await fetch("/api/push/subscribe", { cache: "no-store" });
    const { publicKey } = await k.json() as { publicKey: string | null };
    if (!k.ok || !publicKey) throw new Error("Las notificaciones no están configuradas en el servidor.");
    const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
    const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
    if (!r.ok) throw new Error("No se pudo guardar la suscripción.");
    setState("on"); onMessage("Notificaciones activadas en este dispositivo.", "ok");
  };
  const turnOff = async () => {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
    setState("off"); onMessage("Notificaciones desactivadas en este dispositivo.", "ok");
  };
  const click = async () => {
    if (busy || state === "loading") return;
    setBusy(true);
    try { if (state === "on") await turnOff(); else await turnOn(); }
    catch (e) { onMessage(e instanceof Error ? e.message : "No se pudo cambiar la notificación.", "error"); void refresh(); }
    finally { setBusy(false); }
  };
  if (state === "unsupported") return <div className="profile-menu-item push-unsupported" title="Este navegador no soporta notificaciones push. En iPhone, instalá Serpix en la pantalla de inicio primero." aria-disabled="true"><BellOff size={18} /><span>Notificaciones no disponibles</span></div>;
  const disabled = state === "denied" || state === "loading";
  const tip = state === "denied" ? "Bloqueadas en el navegador: habilitalas en los permisos del sitio" : state === "on" ? "Desactivar avisos de solicitudes en este dispositivo" : "Avisarme de nuevas solicitudes en este dispositivo";
  return <button type="button" className="profile-menu-item theme-menu-toggle" role="switch" aria-checked={state === "on"} disabled={disabled} title={tip} onClick={() => void click()}>{state === "on" ? <Bell size={18} /> : <BellOff size={18} />}<span>Notificaciones</span><span className={"theme-switch " + (state === "on" ? "on" : "")}><span /></span></button>;
}
