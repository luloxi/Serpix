// Screen state for /dashboard. Pure: no DOM, no Next.js. The URL is the source of truth;
// history helpers talk to an injected History-like object so they can be unit-tested.

export type Section = "home" | "contacts" | "activity" | "finance" | "admin";

export type EditTarget = {
  resource: "contacts" | "projects" | "tasks" | "accounts" | "transactions" | "activities";
  id: string;
};

export type NavState = {
  section: Section;
  contactsView: "list" | "inquiries";
  inquiryId: string | null;
  role: "all" | "client" | "partner" | "supplier" | "none";
  relState: "any" | "potential" | "confirmed";
  contactId: string | null;
  agendaTab: "general" | "calendar" | "list";
  agendaKind: "all" | "task" | "event" | "note";
  /** YYYY-MM. Null means "the current month" and is omitted from the URL. */
  month: string | null;
  /** YYYY-MM-DD. Null means "today" and is omitted from the URL. */
  day: string | null;
  noteId: string | null;
  edit: EditTarget | null;
};

export const DEFAULT_NAV: NavState = {
  section: "home",
  contactsView: "list",
  inquiryId: null,
  role: "all",
  relState: "any",
  contactId: null,
  agendaTab: "general",
  agendaKind: "all",
  month: null,
  day: null,
  noteId: null,
  edit: null,
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const CANONICAL_SECTIONS = new Set<Section>(["home", "contacts", "activity", "finance", "admin"]);

/** `section=` accepts the canonical ids plus the old Spanish / alias names. */
const SECTION_ALIAS: Record<string, Section> = {
  home: "home",
  contacts: "contacts",
  activity: "activity",
  finance: "finance",
  admin: "admin",
  agenda: "activity",
  finanzas: "finance",
  contactos: "contacts",
};

const EDIT_RESOURCES = new Set<EditTarget["resource"]>([
  "contacts", "projects", "tasks", "accounts", "transactions", "activities",
]);

export function validMonth(value: string): boolean {
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function validDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Date.UTC maps years 0–99 onto 1900–1999, so the year check rejects those
  // and also rejects impossible days (31 Feb rolls into March).
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function isId(value: string | null): value is string {
  return !!value && ID_RE.test(value);
}

function editAllowed(section: Section, edit: EditTarget | null): edit is EditTarget {
  if (!edit) return false;
  if (section === "contacts") return edit.resource === "contacts";
  if (section === "activity") return edit.resource === "tasks" || edit.resource === "activities";
  if (section === "finance") return edit.resource === "accounts" || edit.resource === "transactions";
  return false;
}

function parseEdit(raw: string | null, section: Section): EditTarget | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const resource = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!EDIT_RESOURCES.has(resource as EditTarget["resource"]) || !isId(id)) return null;
  const edit: EditTarget = { resource: resource as EditTarget["resource"], id };
  return editAllowed(section, edit) ? edit : null;
}

/** Read a location search (`""`, `"?"` or `"?a=b"`) into a nav state. Invalid pieces fall back to defaults. */
export function parseNav(search: string): NavState {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(q);
  const nav: NavState = { ...DEFAULT_NAV };

  const sRaw = params.get("s");
  const sectionRaw = params.get("section");
  if (sRaw && CANONICAL_SECTIONS.has(sRaw as Section)) nav.section = sRaw as Section;
  else if (sectionRaw && SECTION_ALIAS[sectionRaw]) nav.section = SECTION_ALIAS[sectionRaw];

  // Push notifications still open /dashboard?solicitudes=<id>.
  const legacyInquiry = params.get("solicitudes");
  if (isId(legacyInquiry)) {
    nav.section = "contacts";
    nav.contactsView = "inquiries";
    nav.inquiryId = legacyInquiry;
  }

  if (nav.section === "contacts") {
    if (params.get("v") === "solicitudes") nav.contactsView = "inquiries";
    const inquiry = params.get("i");
    if (isId(inquiry)) nav.inquiryId = inquiry;
    if (isId(legacyInquiry)) nav.inquiryId = legacyInquiry;
    const role = params.get("r");
    if (role === "client" || role === "partner" || role === "supplier" || role === "none") nav.role = role;
    const rel = params.get("e");
    if (rel === "potential" || rel === "confirmed") nav.relState = rel;
    const contact = params.get("c");
    if (isId(contact)) nav.contactId = contact;
  }

  if (nav.section === "activity") {
    const tab = params.get("t");
    if (tab === "calendar" || tab === "list") nav.agendaTab = tab;
    const kind = params.get("k");
    if (kind === "task" || kind === "event" || kind === "note") nav.agendaKind = kind;
    const month = params.get("m");
    if (month && validMonth(month)) nav.month = month;
    const day = params.get("d");
    if (day && validDay(day)) nav.day = day;
    const note = params.get("n");
    if (isId(note)) nav.noteId = note;
  }

  nav.edit = parseEdit(params.get("edit"), nav.section);
  return nav;
}

/** `""` for the home screen, otherwise `"?a=b&..."`. Every default is omitted, and so is anything that does not belong to the section. */
export function buildSearch(nav: NavState): string {
  const params = new URLSearchParams();
  if (nav.section !== "home") params.set("s", nav.section);

  if (nav.section === "contacts") {
    if (nav.contactsView === "inquiries") params.set("v", "solicitudes");
    if (isId(nav.inquiryId)) params.set("i", nav.inquiryId);
    if (nav.role !== "all") params.set("r", nav.role);
    if (nav.relState !== "any") params.set("e", nav.relState);
    if (isId(nav.contactId)) params.set("c", nav.contactId);
  }

  if (nav.section === "activity") {
    if (nav.agendaTab === "calendar" || nav.agendaTab === "list") params.set("t", nav.agendaTab);
    if (nav.agendaKind === "task" || nav.agendaKind === "event" || nav.agendaKind === "note") params.set("k", nav.agendaKind);
    if (nav.month && validMonth(nav.month)) params.set("m", nav.month);
    if (nav.day && validDay(nav.day)) params.set("d", nav.day);
    if (isId(nav.noteId)) params.set("n", nav.noteId);
  }

  if (editAllowed(nav.section, nav.edit) && isId(nav.edit.id)) params.set("edit", nav.edit.resource + ":" + nav.edit.id);

  const s = params.toString();
  return s ? "?" + s : "";
}

export function buildUrl(nav: NavState): string {
  return "/dashboard" + buildSearch(nav);
}

export function sameNav(a: NavState, b: NavState): boolean {
  return a.section === b.section
    && a.contactsView === b.contactsView
    && a.inquiryId === b.inquiryId
    && a.role === b.role
    && a.relState === b.relState
    && a.contactId === b.contactId
    && a.agendaTab === b.agendaTab
    && a.agendaKind === b.agendaKind
    && a.month === b.month
    && a.day === b.day
    && a.noteId === b.noteId
    && a.edit?.resource === b.edit?.resource
    && a.edit?.id === b.edit?.id;
}

/** Section changes jump back to the top. Entering the agenda does not: it opens scrolled to today. */
export function shouldResetScroll(prev: string, next: string): boolean {
  return prev !== next && next !== "activity";
}

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

function forbiddenPath(path: string): boolean {
  return path === "/login" || path.startsWith("/login/") || path === "/api" || path.startsWith("/api/");
}

/**
 * Path + search to return to after login, or "/dashboard".
 * Resolves with `new URL(raw, origin)` and requires the same origin.
 * Rejects backslashes, control characters, protocol-relative URLs and a single decode of the same tricks.
 * Drops the hash. `/login` and `/api` are not safe return targets.
 */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/dashboard";
  if (hasControlOrBackslash(raw)) return "/dashboard";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/dashboard";
  }
  if (hasControlOrBackslash(decoded)) return "/dashboard";
  if (raw.startsWith("//") || decoded.startsWith("//")) return "/dashboard";

  const rawAbsolute = /^https?:\/\//i.test(raw);
  const decodedAbsolute = /^https?:\/\//i.test(decoded);
  if (!raw.startsWith("/") && !rawAbsolute) return "/dashboard";
  if (!decoded.startsWith("/") && !decodedAbsolute) return "/dashboard";

  let url: URL;
  let decodedUrl: URL;
  try {
    url = new URL(raw, origin);
    decodedUrl = new URL(decoded, origin);
  } catch {
    return "/dashboard";
  }
  if (url.origin !== origin || decodedUrl.origin !== origin) return "/dashboard";
  if (forbiddenPath(url.pathname) || forbiddenPath(decodedUrl.pathname)) return "/dashboard";
  return url.pathname + url.search;
}

export type Layer = "add" | "editor" | "timer" | "timer-stop" | "note" | "edit" | "doc";

export type HistoryLike = {
  state: unknown;
  pushState(s: unknown, t: string, url?: string): void;
  replaceState(s: unknown, t: string, url?: string): void;
  back(): void;
};

const LAYERS = new Set<Layer>(["add", "editor", "timer", "timer-stop", "note", "edit", "doc"]);

export function layerOf(state: unknown): Layer | null {
  if (!state || typeof state !== "object") return null;
  const layer = (state as { serpixLayer?: unknown }).serpixLayer;
  return typeof layer === "string" && LAYERS.has(layer as Layer) ? layer as Layer : null;
}

/** A new screen. A layer left on top is replaced so it does not stay in the stack. */
export function pushScreen(h: HistoryLike, url: string): void {
  if (layerOf(h.state)) h.replaceState(null, "", url);
  else h.pushState(null, "", url);
}

/** Filters, accordion and calendar month: same history entry, same layer marker. */
export function refine(h: HistoryLike, url: string): void {
  h.replaceState(h.state, "", url);
}

/**
 * Open a layer. A layer already on top is replaced (sheet → form, note → edit)
 * so the chain does not leave extra entries. `url` omitted keeps the current URL.
 */
export function openLayer(h: HistoryLike, layer: Layer, url?: string): void {
  const state = { serpixLayer: layer };
  if (layerOf(h.state)) h.replaceState(state, "", url);
  else h.pushState(state, "", url);
}

/** Back only when a layer is the current entry. Otherwise the caller clears UI state itself. */
export function closeLayer(h: HistoryLike): boolean {
  if (!layerOf(h.state)) return false;
  h.back();
  return true;
}
