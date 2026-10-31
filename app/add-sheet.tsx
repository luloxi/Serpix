"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { toneForIndex } from "@/lib/palette";

export type AddSheetAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
};

export default function AddSheet({
  open,
  onClose,
  actions,
  activeId,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  actions: AddSheetAction[];
  activeId?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = !!dialog && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
      // Strict-mode replays this cleanup while the dialog is still mounted. Only
      // restore the trigger once the sheet is actually gone, and not if an editor opened.
      const stillOpen = !!document.getElementById("serpix-add-sheet");
      const editorOpen = !!document.querySelector(".modal-backdrop");
      if (!stillOpen && !editorOpen) trigger?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div className="add-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <section
        ref={dialogRef}
        className="add-sheet"
        id="serpix-add-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-sheet-title"
      >
        <div className="add-sheet-grabber" aria-hidden="true" />
        <h2 id="add-sheet-title" className="add-sheet-title">Agregar nuevo</h2>
        <div className="add-sheet-grid">
          {actions.map((action, index) => {
            const Icon = action.icon;
            const current = action.id === activeId;
            return (
              <button
                key={action.id}
                type="button"
                className={"add-sheet-action tone-" + toneForIndex(index)}
                title={action.label}
                aria-label={action.label}
                aria-current={current ? "true" : undefined}
                onClick={() => action.onSelect()}
              >
                <span className="add-sheet-icon" aria-hidden="true"><Icon size={26} strokeWidth={2} /></span>
                <span className="add-sheet-label">{action.label}</span>
              </button>
            );
          })}
        </div>
      </section>
    </>,
    document.body,
  );
}
