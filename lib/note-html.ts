// Note body stored in activities.body. Plain markdown stays plain so old notes keep decrypting and rendering.
// Rich text is a sanitized HTML string in that same column (encrypted with the activity row for e2e accounts).
import { isNoteMediaPath } from "./note-media.ts";

/** Room for a few shrunk images inside one encrypted activity blob (cap is 1.9M characters). */
export const MAX_NOTE_BODY_CHARS = 900_000;
export const MAX_EVENT_BODY_CHARS = 30_000;
export const NOTE_TOO_BIG = "La nota es demasiado larga. Sacá alguna imagen o achicá el texto.";
/** One embedded image, after base64. Several of these still fit in MAX_NOTE_BODY_CHARS. */
export const MAX_DATA_URL_CHARS = 280_000;

const RICH_START = /^<(p|h1|h2|h3|ul|ol|blockquote|pre|img)\b/i;
const DROP = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "noscript", "template", "textarea", "title"]);
const ALLOWED = new Set(["p", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "strong", "em", "u", "code", "a", "br", "img"]);
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*(\/?)>|([^<]+)|</g;
const DATA_IMG = /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i;

export function isRichNoteHtml(value: string): boolean {
  return RICH_START.test(value.trim());
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (all, name: string) => {
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return "\"";
    if (name === "apos") return "'";
    if (name === "nbsp") return "\u00A0";
    const hex = name[1] === "x";
    const cp = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
    return String.fromCodePoint(cp);
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

function cleanText(text: string): string {
  return decodeEntities(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function safeNoteHref(raw: string): string | null {
  const value = cleanText(raw).replace(/[\u0000-\u001F\s]/g, "");
  if (!value || value.length > 2000) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  if (url.protocol === "mailto:" && url.pathname.length > 0 && url.pathname.length <= 200) return url.href;
  return null;
}

export function safeNoteImageSrc(raw: string): string | null {
  const value = cleanText(raw).replace(/[\u0000-\u001F\s]/g, "");
  if (isNoteMediaPath(value)) return value;
  const match = DATA_IMG.exec(value);
  if (!match || value.length > MAX_DATA_URL_CHARS) return null;
  return `data:image/${match[1].toLowerCase()};base64,${value.slice(value.indexOf(",") + 1)}`;
}

function quotedAttrs(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const match of raw.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) map.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  return map;
}

function canonicalTag(name: string): string {
  const tag = name.toLowerCase();
  if (tag === "b") return "strong";
  if (tag === "i") return "em";
  return tag;
}

function isVisuallyEmpty(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  const text = html.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\u00A0/g, " ");
  return text.trim().length === 0;
}

/** Keeps headings, marks, lists, links and safe images. Drops scripts, handlers and foreign URLs. */
export function sanitizeNoteHtml(input: string): string {
  const src = input.replace(/\u0000/g, "");
  TOKEN.lastIndex = 0;
  let out = "";
  const stack: string[] = [];
  let dropping: { tag: string; depth: number } | null = null;
  const closeTag = (tag: string) => {
    const index = stack.lastIndexOf(tag);
    if (index < 0) return;
    while (stack.length > index) out += `</${stack.pop()}>`;
  };
  for (const match of src.matchAll(TOKEN)) {
    if (dropping) {
      const open = match[2] ? canonicalTag(match[2]) : "";
      const close = match[1] ? canonicalTag(match[1]) : "";
      if (open === dropping.tag) dropping.depth += 1;
      else if (close === dropping.tag) {
        dropping.depth -= 1;
        if (dropping.depth <= 0) dropping = null;
      }
      continue;
    }
    if (match[5] != null) {
      out += escapeText(cleanText(match[5]));
      continue;
    }
    if (match[0] === "<") {
      out += "&lt;";
      continue;
    }
    if (match[1]) {
      closeTag(canonicalTag(match[1]));
      continue;
    }
    if (!match[2]) continue;
    const tag = canonicalTag(match[2]);
    if (DROP.has(tag)) {
      if (!match[4]) dropping = { tag, depth: 1 };
      continue;
    }
    const attrs = quotedAttrs(match[3]);
    if (tag === "img") {
      const srcAttr = safeNoteImageSrc(attrs.get("src") ?? "");
      if (!srcAttr) continue;
      const alt = escapeAttr(cleanText(attrs.get("alt") ?? "").replace(/\s+/g, " ").trim().slice(0, 180));
      out += `<img src="${escapeAttr(srcAttr)}" alt="${alt}">`;
      continue;
    }
    if (tag === "br") {
      out += "<br>";
      continue;
    }
    if (!ALLOWED.has(tag)) continue;
    if (tag === "a") {
      const href = safeNoteHref(attrs.get("href") ?? "");
      if (!href) continue;
      if (match[4]) continue;
      out += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`;
      stack.push("a");
      continue;
    }
    if (match[4]) {
      out += `<${tag}></${tag}>`;
      continue;
    }
    out += `<${tag}>`;
    stack.push(tag);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

function inlineHtml(text: string): string {
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    out += escapeText(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("**")) out += `<strong>${escapeText(token.slice(2, -2))}</strong>`;
    else if (token.startsWith("`")) out += `<code>${escapeText(token.slice(1, -1))}</code>`;
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link ? safeNoteHref(link[2]) : null;
      out += href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeText(link![1])}</a>` : escapeText(token);
    } else out += `<em>${escapeText(token.slice(1, -1))}</em>`;
    last = index + token.length;
  }
  out += escapeText(text.slice(last));
  return out;
}

/** Same markdown the agenda reader already understood, as HTML the editor can load. */
export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${inlineHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push(`<h${heading[1].length}>${inlineHtml(heading[2])}</h${heading[1].length}>`);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet || numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks.join("") || "<p></p>";
}

export function noteBodyToEditorHtml(source: string): string {
  const text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) return "<p></p>";
  if (!isRichNoteHtml(text)) return markdownToHtml(text);
  const clean = sanitizeNoteHtml(text);
  return clean && !isVisuallyEmpty(clean) ? clean : "<p></p>";
}

/** What we persist. Markdown that never went through the editor is returned unchanged. */
export function editorHtmlToStored(html: string): string {
  const raw = html.replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  if (!isRichNoteHtml(raw)) return raw.slice(0, MAX_NOTE_BODY_CHARS);
  const clean = sanitizeNoteHtml(raw);
  if (!clean || isVisuallyEmpty(clean)) return "";
  return clean;
}

export function prepareActivityBody(kind: string, value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (kind !== "note") {
    const text = typeof value === "string" ? value.trim().slice(0, MAX_EVENT_BODY_CHARS) : "";
    return { ok: true, value: text || null };
  }
  if (typeof value !== "string") return { ok: true, value: null };
  const raw = value.trim();
  if (!raw) return { ok: true, value: null };
  if (!isRichNoteHtml(raw)) return { ok: true, value: raw.slice(0, MAX_NOTE_BODY_CHARS) };
  if (raw.length > MAX_NOTE_BODY_CHARS) return { ok: false, error: NOTE_TOO_BIG };
  const clean = sanitizeNoteHtml(raw);
  if (!clean || isVisuallyEmpty(clean)) return { ok: true, value: null };
  if (clean.length > MAX_NOTE_BODY_CHARS) return { ok: false, error: NOTE_TOO_BIG };
  return { ok: true, value: clean };
}
