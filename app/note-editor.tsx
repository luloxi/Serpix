"use client";

import { Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Camera, Code, Heading1, Heading2, Heading3, Image as ImageIcon, Italic, Link, List, ListOrdered, Redo2, Underline, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { blobToDataUrl, shrinkNoteImage } from "@/lib/note-image";
import { editorHtmlToStored, MAX_NOTE_BODY_CHARS, noteBodyToEditorHtml, NOTE_TOO_BIG, safeNoteHref, safeNoteImageSrc, sanitizeNoteHtml } from "@/lib/note-html";
import { isNoteMediaPath } from "@/lib/note-media";

type Props = {
  label: string;
  value: string;
  e2e?: boolean;
  onChange: (body: string) => void;
  onError: (message: string) => void;
};

function allowNoteLink(url: string): boolean {
  if (safeNoteHref(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  return safeNoteHref(`https://${url}`) !== null;
}

async function storeNoteImage(file: File, e2e: boolean): Promise<string> {
  const blob = await shrinkNoteImage(file);
  if (e2e) {
    const src = await blobToDataUrl(blob);
    if (!safeNoteImageSrc(src)) throw new Error("No se pudo usar esa imagen.");
    return src;
  }
  const form = new FormData();
  form.set("file", blob, "nota.jpg");
  const response = await fetch("/api/note-media", { method: "POST", body: form });
  const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !data.url || !isNoteMediaPath(data.url)) throw new Error(data.error || "No se pudo subir la imagen");
  return data.url;
}

function Tool({ label, shortcut, pressed, disabled, onClick, children }: { label: string; shortcut?: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={"note-tool" + (pressed ? " is-active" : "")} aria-label={shortcut ? `${label} (${shortcut})` : label} title={shortcut ? `${label} (${shortcut})` : label} aria-pressed={pressed} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

export default function NoteEditor({ label, value, e2e = false, onChange, onError }: Props) {
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const e2eRef = useRef(e2e);
  const editorRef = useRef<Editor | null>(null);
  const uploadRef = useRef<(file: File) => void>(() => {});
  const linkOpener = useRef<() => void>(() => {});
  const reverting = useRef(false);
  const busy = useRef(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");

  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      strike: false,
      codeBlock: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        enableClickSelection: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        isAllowedUri: (url) => allowNoteLink(url),
      },
    }),
    Image.configure({ allowBase64: true, resize: false }),
    Placeholder.configure({ placeholder: "Escribí la nota…" }),
    Extension.create({
      name: "noteKeys",
      addKeyboardShortcuts() {
        return {
          "Mod-k": () => { linkOpener.current(); return true; },
          "Mod-Alt-1": () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
          "Mod-Alt-2": () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
          "Mod-Alt-3": () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
        };
      },
    }),
  ], []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: noteBodyToEditorHtml(value),
    editorProps: {
      attributes: { class: "note-prose", role: "textbox", "aria-multiline": "true", "aria-label": "Contenido de la nota", spellcheck: "true" },
      transformPastedHTML: (html) => sanitizeNoteHtml(html),
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith("image/"));
        if (!file) return false;
        event.preventDefault();
        uploadRef.current(file);
        return true;
      },
      handleDrop: (_view, event) => {
        const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith("image/"));
        if (!file) return false;
        event.preventDefault();
        uploadRef.current(file);
        return true;
      },
    },
    onCreate: ({ editor: current }) => {
      onChangeRef.current(editorHtmlToStored(current.getHTML()));
    },
    onUpdate: ({ editor: current }) => {
      if (reverting.current) return;
      const stored = editorHtmlToStored(current.getHTML());
      if (stored.length > MAX_NOTE_BODY_CHARS) {
        reverting.current = true;
        current.commands.undo();
        reverting.current = false;
        onErrorRef.current(NOTE_TOO_BIG);
        return;
      }
      onChangeRef.current(stored);
    },
  });

  const active = useEditorState({
    editor,
    selector: (snapshot) => {
      const current = snapshot.editor;
      if (!current) return null;
      return {
        h1: current.isActive("heading", { level: 1 }),
        h2: current.isActive("heading", { level: 2 }),
        h3: current.isActive("heading", { level: 3 }),
        bold: current.isActive("bold"),
        italic: current.isActive("italic"),
        underline: current.isActive("underline"),
        code: current.isActive("code"),
        bullet: current.isActive("bulletList"),
        ordered: current.isActive("orderedList"),
        link: current.isActive("link"),
        undo: current.can().undo(),
        redo: current.can().redo(),
      };
    },
  });

  useEffect(() => { if (linkOpen) linkInputRef.current?.focus(); }, [linkOpen]);

  const upload = (file: File) => {
    const current = editorRef.current;
    if (!current || busy.current) return;
    busy.current = true;
    setStatus("Subiendo imagen…");
    void (async () => {
      try {
        const src = await storeNoteImage(file, e2eRef.current);
        if (!editorRef.current || editorRef.current.isDestroyed) return;
        editorRef.current.chain().focus().setImage({ src, alt: "Imagen" }).run();
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : "No se pudo subir la imagen");
      } finally {
        busy.current = false;
        setStatus("");
      }
    })();
  };

  const openLink = () => {
    const current = editorRef.current;
    if (!current) return;
    const href = current.getAttributes("link").href;
    setDraft(typeof href === "string" ? href : "");
    setLinkOpen(true);
  };

  useEffect(() => {
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
    e2eRef.current = e2e;
    editorRef.current = editor;
    uploadRef.current = upload;
    linkOpener.current = openLink;
  });

  const applyLink = (event: FormEvent) => {
    event.preventDefault();
    const current = editorRef.current;
    if (!current) return;
    const typed = draft.trim();
    const href = safeNoteHref(typed) || (!/^[a-z][a-z0-9+.-]*:/i.test(typed) ? safeNoteHref(`https://${typed}`) : null);
    if (!href) {
      onError("El enlace tiene que ser http, https o mailto.");
      return;
    }
    const chain = current.chain().focus();
    if (current.state.selection.empty && !current.isActive("link")) chain.insertContent({ type: "text", text: typed || href, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.extendMarkRange("link").setLink({ href }).run();
    setLinkOpen(false);
  };

  const pick = (list: FileList | null, input: HTMLInputElement | null) => {
    const file = list?.[0];
    if (input) input.value = "";
    if (file) upload(file);
  };

  const run = (command: (current: Editor) => void) => {
    if (editor) command(editor);
  };

  return <div className="note-field span-2">
    <span className="field-label">{label}</span>
    <div className="note-editor">
      <div className="note-toolbar-wrap">
        <div className="note-toolbar" role="toolbar" aria-label="Formato de la nota">
          <Tool label="Título 1" shortcut="Ctrl+Alt+1" pressed={active?.h1} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleHeading({ level: 1 }).run())}><Heading1 size={18} aria-hidden="true" /></Tool>
          <Tool label="Título 2" shortcut="Ctrl+Alt+2" pressed={active?.h2} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleHeading({ level: 2 }).run())}><Heading2 size={18} aria-hidden="true" /></Tool>
          <Tool label="Título 3" shortcut="Ctrl+Alt+3" pressed={active?.h3} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleHeading({ level: 3 }).run())}><Heading3 size={18} aria-hidden="true" /></Tool>
          <span className="note-tool-sep" aria-hidden="true" />
          <Tool label="Negrita" shortcut="Ctrl+B" pressed={active?.bold} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleBold().run())}><Bold size={18} aria-hidden="true" /></Tool>
          <Tool label="Cursiva" shortcut="Ctrl+I" pressed={active?.italic} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleItalic().run())}><Italic size={18} aria-hidden="true" /></Tool>
          <Tool label="Subrayado" shortcut="Ctrl+U" pressed={active?.underline} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleUnderline().run())}><Underline size={18} aria-hidden="true" /></Tool>
          <Tool label="Código" shortcut="Ctrl+E" pressed={active?.code} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleCode().run())}><Code size={18} aria-hidden="true" /></Tool>
          <span className="note-tool-sep" aria-hidden="true" />
          <Tool label="Lista" pressed={active?.bullet} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleBulletList().run())}><List size={18} aria-hidden="true" /></Tool>
          <Tool label="Lista numerada" pressed={active?.ordered} disabled={!editor} onClick={() => run((current) => current.chain().focus().toggleOrderedList().run())}><ListOrdered size={18} aria-hidden="true" /></Tool>
          <span className="note-tool-sep" aria-hidden="true" />
          <Tool label="Enlace" shortcut="Ctrl+K" pressed={active?.link || linkOpen} disabled={!editor} onClick={openLink}><Link size={18} aria-hidden="true" /></Tool>
          <Tool label="Subir imagen" disabled={!editor || status !== ""} onClick={() => fileRef.current?.click()}><ImageIcon size={18} aria-hidden="true" /></Tool>
          <Tool label="Sacar foto" disabled={!editor || status !== ""} onClick={() => cameraRef.current?.click()}><Camera size={18} aria-hidden="true" /></Tool>
          <span className="note-tool-sep" aria-hidden="true" />
          <Tool label="Deshacer" shortcut="Ctrl+Z" disabled={!editor || !active?.undo} onClick={() => run((current) => current.chain().focus().undo().run())}><Undo2 size={18} aria-hidden="true" /></Tool>
          <Tool label="Rehacer" shortcut="Ctrl+Shift+Z" disabled={!editor || !active?.redo} onClick={() => run((current) => current.chain().focus().redo().run())}><Redo2 size={18} aria-hidden="true" /></Tool>
        </div>
        {status && <p className="note-status" role="status">{status}</p>}
        {linkOpen && <form className="note-link-bar" onSubmit={applyLink}>
          <input ref={linkInputRef} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://…" aria-label="Dirección del enlace" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setLinkOpen(false); editor?.commands.focus(); } }} />
          <button type="submit" className="primary">Aplicar</button>
          {active?.link && <button type="button" onClick={() => { editor?.chain().focus().unsetLink().run(); setLinkOpen(false); }}>Quitar</button>}
          <button type="button" onClick={() => { setLinkOpen(false); editor?.commands.focus(); }}>Cancelar</button>
        </form>}
      </div>
      {editor ? <EditorContent editor={editor} /> : <p className="note-editor-loading">Cargando el editor…</p>}
      <input ref={fileRef} className="note-file" type="file" accept="image/jpeg,image/png,image/webp,image/*" tabIndex={-1} aria-hidden="true" onChange={(event) => pick(event.target.files, event.target)} />
      <input ref={cameraRef} className="note-file" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true" onChange={(event) => pick(event.target.files, event.target)} />
    </div>
  </div>;
}
