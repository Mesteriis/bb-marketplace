// The composer's rich-text editor: TipTap with the schema the server keeps
// (paragraphs, lists, quotes, hard breaks; bold, italic, underline and
// http/https/mailto links). It emits the document JSON only, never HTML.
// HTML that comes in (a quoted original, a continued draft, a paste) goes
// through the email sanitizer with remote images off and loses every image
// and style before TipTap parses it, so the editor never loads anything.
import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "@/lib/utils";
import { sanitizeEmailHtml } from "./sanitize.ts";

/** The document the editor emits and the server validates. */
export type EditorDoc = JSONContent;

/** Elements removed after sanitizing: anything that shows or loads media, and CSS. */
const DROPPED = "img, picture, source, video, audio, track, svg, style, link, meta, title";

/**
 * Untrusted HTML as editor input: sanitized (remote images off), every image
 * (remote, data: and cid:) and style removed, the body's markup only. Parsed
 * in an inert document, so nothing here loads a resource.
 */
export function cleanEditorHtml(html: string): string {
  const sanitized = sanitizeEmailHtml(html, { remoteImages: false }).html;
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll(DROPPED))) element.remove();
  return doc.body.innerHTML;
}

/** Link protocols the editor and the server's renderer keep. */
export const LINK_PROTOCOLS = ["http", "https", "mailto"];

/** The StarterKit as the composer uses it: the server's schema, nothing more. */
export function composeExtensions() {
  return [
    StarterKit.configure({
      heading: false,
      code: false,
      codeBlock: false,
      strike: false,
      horizontalRule: false,
      link: { openOnClick: false, autolink: true, protocols: LINK_PROTOCOLS, defaultProtocol: "https" },
    }),
  ];
}

/**
 * Loads a draft's imported HTML once: as a quote at the end of the document
 * (a reply or forward), or as the whole body (a continued draft).
 */
export function importHtml(editor: Editor, html: string, into: "quote" | "body"): void {
  const clean = cleanEditorHtml(html);
  if (into === "body") {
    editor.commands.setContent(clean === "" ? "<p></p>" : clean, { emitUpdate: true });
    return;
  }
  const end = editor.state.doc.content.size;
  editor.commands.insertContentAt(end, `<blockquote>${clean === "" ? "<p></p>" : clean}</blockquote>`, {
    updateSelection: false,
  });
  editor.commands.setTextSelection(1);
}

/** Files of a paste or a drop; empty when it carries none. */
function filesOf(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export interface ComposeEditorProps {
  /** The saved document; read once, when the editor starts. */
  initialDoc: EditorDoc;
  /** HTML to load once after the editor starts (DraftView.import), or null. */
  importFrom: { html: string; into: "quote" | "body" } | null;
  onChange: (doc: EditorDoc) => void;
  /** Files pasted or dropped into the editor. */
  onFiles: (files: File[]) => void;
  /** The editor, once it exists (the toolbar drives it). */
  onReady: (editor: Editor) => void;
  /**
   * The imported HTML is in the document (the host saves it now, so it is
   * imported once). A load, not an edit: onChange does not fire for it.
   */
  onImported?: (doc: EditorDoc) => void;
  /** Cmd/Ctrl+K in the editor. */
  onLinkShortcut: () => void;
  label: string;
  className?: string;
}

export function ComposeEditor({
  initialDoc,
  importFrom,
  onChange,
  onFiles,
  onReady,
  onImported,
  onLinkShortcut,
  label,
  className,
}: ComposeEditorProps) {
  const handlers = useRef({ onChange, onFiles, onLinkShortcut, onImported });
  handlers.current = { onChange, onFiles, onLinkShortcut, onImported };
  const imported = useRef(false);
  const importing = useRef(false);

  const editor = useEditor({
    extensions: composeExtensions(),
    content: initialDoc,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": label,
        "aria-multiline": "true",
        class: cn(
          "min-h-40 w-full px-3 py-2 text-sm leading-relaxed text-foreground outline-none",
          "[&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
          "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:min-h-[1lh]",
          "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        ),
      },
      transformPastedHTML: (html) => cleanEditorHtml(html),
      handlePaste: (_view, event) => {
        const files = filesOf(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        handlers.current.onFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = filesOf((event as DragEvent).dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        handlers.current.onFiles(files);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.code === "KeyK") {
          event.preventDefault();
          handlers.current.onLinkShortcut();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      if (!importing.current) handlers.current.onChange(current.getJSON());
    },
  });

  useEffect(() => {
    if (editor === null) return;
    onReady(editor);
    if (importFrom !== null && !imported.current) {
      imported.current = true;
      importing.current = true;
      try {
        importHtml(editor, importFrom.html, importFrom.into);
      } finally {
        importing.current = false;
      }
      handlers.current.onImported?.(editor.getJSON());
    }
    // onReady and importFrom are read once per editor.
  }, [editor]);

  return <EditorContent editor={editor} className={cn("min-h-0", className)} />;
}
