"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { buenosAiresDate } from "@/lib/luma-events";

export type LumaEventItem = {
  id: string;
  name: string;
  startsAt: string;
  endsAt?: string | null;
  url?: string | null;
  location?: string | null;
};

type Suggestion = { key: string; label: string; fromLuma: boolean; at: string };

const MAX_OPTIONS = 20;

function dayLabel(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  return new Date(ymd + "T12:00:00").toLocaleDateString("es-AR");
}

/** Free-text event with Luma and previously used names. Picking Luma sets the Buenos Aires date; anything else clears it. */
export function EventField({ label, value, luma, usedNames, onChange }: {
  label: string;
  value: string;
  luma: LumaEventItem[];
  usedNames: string[];
  onChange: (patch: { metEvent: string; metEventAt: string }) => void;
}) {
  const reactId = useId();
  const inputId = reactId + "-input";
  const listId = reactId + "-list";
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const ordered = useMemo(
    () => [...luma].sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt))),
    [luma],
  );

  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const items: Suggestion[] = [];
    for (const event of ordered) {
      const name = event.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key: event.id, label: name, fromLuma: true, at: buenosAiresDate(event.startsAt) ?? "" });
    }
    for (const raw of usedNames) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key: "used:" + key, label: name, fromLuma: false, at: "" });
    }
    const query = value.trim().toLowerCase();
    const filtered = query ? items.filter((item) => item.label.toLowerCase().includes(query)) : items;
    return filtered.slice(0, MAX_OPTIONS);
  }, [ordered, usedNames, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (!open || suggestions.length === 0) return;
    document.getElementById(listId + "-" + active)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId, suggestions.length]);

  function dateOf(labelText: string): string {
    const match = ordered.find((event) => event.name.trim() === labelText.trim());
    return match ? (buenosAiresDate(match.startsAt) ?? "") : "";
  }

  function choose(item: Suggestion) {
    onChange({ metEvent: item.label, metEventAt: item.fromLuma ? item.at : dateOf(item.label) });
    setOpen(false);
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      if (suggestions.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter" && open && suggestions[active]) {
      event.preventDefault();
      choose(suggestions[active]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const shown = open && suggestions.length > 0;
  const activeId = shown ? listId + "-" + active : undefined;

  return (
    <div className="span-2 event-field" ref={rootRef}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="event-field-input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={activeId}
        autoComplete="off"
        placeholder="Escribí o elegí un evento"
        value={value}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(event) => {
          const text = event.target.value;
          onChange({ metEvent: text, metEventAt: dateOf(text) });
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {shown && (
        <ul id={listId} className="event-suggest" role="listbox" aria-label={label}>
          {suggestions.map((item, index) => (
            <li key={item.key} role="presentation">
              <button
                type="button"
                id={listId + "-" + index}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <span>{item.label}</span>
                {item.fromLuma && item.at ? <small>{dayLabel(item.at)}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
