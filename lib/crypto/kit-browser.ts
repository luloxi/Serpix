// Browser-only helpers for the recovery kit. Not imported by the node tests.

import type { RecoveryKit } from "./kit.ts";

export function downloadKit(kit: Pick<RecoveryKit, "filename" | "text">): void {
  if (typeof document === "undefined") throw new Error("downloadKit requires a browser document");
  const blob = new Blob([kit.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = kit.filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function printKit(kit: Pick<RecoveryKit, "html">): void {
  if (typeof window === "undefined") throw new Error("printKit requires a browser window");
  const popup = window.open("", "_blank", "noopener,noreferrer");
  if (!popup) throw new Error("the browser blocked the print window");
  popup.document.open();
  popup.document.write(kit.html);
  popup.document.close();
  popup.focus();
  popup.print();
}
