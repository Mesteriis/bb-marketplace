// The composer's rich-text editor: TipTap with the schema the server keeps
// (paragraphs, lists, quotes, code blocks, hard breaks; bold, italic,
// underline, inline code and http/https/mailto links). It emits the document JSON only, never HTML.
// HTML that comes in (a quoted original, a continued draft, a paste) goes
// through the email sanitizer with remote images off and loses every image
// and style before TipTap parses it, so the editor never loads anything.
import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PmNode } from "@tiptap/pm/model";
import { cn } from "@/lib/utils";
import { sanitizeEmailHtml } from "./sanitize.ts";
import {
  SIGNATURE_CLASS,
  SIGNATURE_REPLACE_META,
  SignatureDocument,
  SignatureNode,
  withoutSignatureClass,
} from "./signature-node.ts";

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
  return cleanEditorBody(html).innerHTML;
}

function cleanEditorBody(html: string): HTMLElement {
  const sanitized = sanitizeEmailHtml(html, { remoteImages: false }).html;
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll(DROPPED))) element.remove();
  return doc.body;
}

/**
 * Pasted or dropped HTML: cleaned as above, and without the signature
 * class, so a copied signature (or a sender's look-alike) pastes as
 * ordinary paragraphs (spec resolution 17).
 */
export function cleanPastedHtml(html: string): string {
  const body = cleanEditorBody(html);
  withoutSignatureClass(body);
  return body.innerHTML;
}

/** Link protocols the editor and the server's renderer keep. */
export const LINK_PROTOCOLS = ["http", "https", "mailto"];

/**
 * What an editor offers beyond paragraphs and marks. The composer has
 * everything; the signature editor has no lists or quotes, the template
 * editor no quotes (slice 3d).
 */
export interface EditorFeatures {
  lists?: boolean;
  quotes?: boolean;
  /** The top-level signature block (the composer only). */
  signature?: boolean;
  /** Code blocks and inline code (slice 3g); off in the signature editor. */
  code?: boolean;
}

/** The StarterKit as the composer uses it: the server's schema, nothing more. */
export function composeExtensions(features: EditorFeatures = {}) {
  const lists = features.lists ?? true;
  const quotes = features.quotes ?? true;
  const signature = features.signature ?? true;
  const code = features.code ?? true;
  return [
    StarterKit.configure({
      ...(signature ? { document: false } : {}),
      // A signature at the end stays the last block (its `-- ` is drawn then).
      trailingNode: { notAfter: ["paragraph", "signature"] },
      heading: false,
      ...(code ? { codeBlock: { languageClassPrefix: "language-" } } : { code: false, codeBlock: false }),
      strike: false,
      horizontalRule: false,
      ...(lists ? {} : { bulletList: false, orderedList: false, listItem: false, listKeymap: false }),
      ...(quotes ? {} : { blockquote: false }),
      link: { openOnClick: false, autolink: true, protocols: LINK_PROTOCOLS, defaultProtocol: "https" },
    }),
    ...(signature ? [SignatureDocument, SignatureNode] : []),
  ];
}

/**
 * Loads a draft's imported HTML once: as a quote at the end of the document
 * (a reply or forward), or as the whole body (a continued draft).
 * `stripSignature` (a reply to the owner's own mail) drops the marked
 * signature blocks; otherwise only their class goes, so their text stays as
 * ordinary text and no second signature block reaches the editor (spec
 * resolution 3).
 */
export function importHtml(editor: Editor, html: string, into: "quote" | "body", stripSignature = false): void {
  const body = cleanEditorBody(html);
  if (stripSignature) {
    for (const element of Array.from(body.querySelectorAll(`div.${SIGNATURE_CLASS}`))) element.remove();
  } else {
    withoutSignatureClass(body);
  }
  const clean = body.innerHTML;
  if (into === "body") {
    editor
      .chain()
      .setMeta(SIGNATURE_REPLACE_META, true)
      .setContent(clean === "" ? "<p></p>" : clean, { emitUpdate: true })
      .run();
    return;
  }
  const end = editor.state.doc.content.size;
  editor.commands.insertContentAt(end, `<blockquote>${clean === "" ? "<p></p>" : clean}</blockquote>`, {
    updateSelection: false,
  });
  editor.commands.setTextSelection(1);
}

// ---- Improve (slice 3f): the owner's own range ----

/** Line breaks become "\n", tabs spaces; every other control character goes (as the server's normalizeDoc). */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Every paragraph inside a block, in order: lists and quotes opened up. */
function paragraphsIn(node: JSONContent): JSONContent[] {
  if (node.type === "paragraph") return [node];
  return (node.content ?? []).flatMap(paragraphsIn);
}

/**
 * The owner's own text as Improve sends it, from the editor's document: the
 * blocks before the first blockquote or signature, one string per paragraph
 * with hardBreak lines joined by "\n", a list as one paragraph with its
 * items as lines. The same rule as the server's ownerParagraphs over the
 * saved draft (a test compares them), so the server can check the draft did
 * not change. `hasMarks`: bold, italic, underline or a link in that range.
 */
export function ownerParagraphsOf(doc: JSONContent): { paragraphs: string[]; hasMarks: boolean } {
  const paragraphs: string[] = [];
  let hasMarks = false;
  const inline = (node: JSONContent): string => {
    if (node.type === "hardBreak") return "\n";
    if (node.type === "text") {
      if ((node.marks ?? []).length > 0) hasMarks = true;
      return cleanText(node.text ?? "");
    }
    return (node.content ?? []).map(inline).join("");
  };
  const text = (paragraph: JSONContent) => (paragraph.content ?? []).map(inline).join("");
  for (const block of doc.content ?? []) {
    if (block.type === "blockquote" || block.type === "signature") break;
    if (block.type === "paragraph") paragraphs.push(text(block));
    else if (block.type === "codeBlock") {
      // As the server's ownerParagraphs: Apply writes paragraphs, so the code formatting counts as a mark.
      hasMarks = true;
      paragraphs.push((block.content ?? []).map((node) => node.text ?? "").join(""));
    } else paragraphs.push(paragraphsIn(block).map(text).join("\n"));
  }
  return { paragraphs, hasMarks };
}

export interface OwnerRange {
  /** Document positions of the range: from the start to the first quote or signature. */
  from: number;
  to: number;
  paragraphs: string[];
  hasMarks: boolean;
}

/** The owner's range of the composer's document now. */
export function ownerRange(editor: Editor): OwnerRange {
  const doc = editor.state.doc;
  let to = doc.content.size;
  let found = false;
  doc.forEach((node: PmNode, offset: number) => {
    if (found) return;
    if (node.type.name === "blockquote" || node.type.name === "signature") {
      to = offset;
      found = true;
    }
  });
  return { from: 0, to, ...ownerParagraphsOf(editor.getJSON()) };
}

/**
 * Replaces the owner's range with `paragraphs` as plain paragraphs ("\n"
 * becomes a hard break, no marks) in one transaction, so one Undo restores
 * the text before. The quote and the signature after it are not touched.
 */
export function replaceOwnerRange(editor: Editor, paragraphs: readonly string[]): void {
  const { state } = editor;
  const { schema } = state;
  const { to } = ownerRange(editor);
  const nodes = (paragraphs.length > 0 ? paragraphs : [""]).map((paragraph) => {
    const inline: PmNode[] = [];
    paragraph.split("\n").forEach((line, index) => {
      if (index > 0) inline.push(schema.nodes.hardBreak!.create());
      if (line !== "") inline.push(schema.text(line));
    });
    return schema.nodes.paragraph!.create(null, inline);
  });
  const tr = closeHistory(state.tr.replaceWith(0, to, nodes));
  editor.view.dispatch(tr);
}

/** A fence line that opens a code block: ``` with an optional language word. */
const FENCE_OPEN = /^```([a-z0-9+#-]{0,20})$/i;

/**
 * Pasted plain text with a fenced block, as editor content: text lines as
 * paragraphs, each fenced run as a code block (its lines verbatim). Null
 * when the text has no complete fence, so the paste stays as it was.
 */
export function fencedPaste(text: string): JSONContent[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: JSONContent[] = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!.trim());
    const close = open === null ? -1 : lines.findIndex((line, j) => j > i && line.trim() === "```");
    if (open !== null && close !== -1) {
      found = true;
      const code = lines.slice(i + 1, close).join("\n");
      const language = open[1] !== undefined && open[1] !== "" ? open[1].toLowerCase() : null;
      out.push({ type: "codeBlock", attrs: { language }, ...(code !== "" ? { content: [{ type: "text", text: code }] } : {}) });
      i = close;
      continue;
    }
    const line = lines[i]!;
    out.push(line === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: line }] });
  }
  return found ? out : null;
}

/** Enter after ``` (and a language) on an empty line turns the line into a code block. */
function fenceEnter(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
  const match = FENCE_OPEN.exec($from.parent.textContent);
  if (match === null || editor.schema.nodes.codeBlock === undefined) return false;
  const language = match[1] !== undefined && match[1] !== "" ? match[1].toLowerCase() : null;
  return editor
    .chain()
    .command(({ tr }) => {
      tr.delete($from.start(), $from.end());
      return true;
    })
    .setNode("codeBlock", { language })
    .run();
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
  importFrom: { html: string; into: "quote" | "body"; stripSignature?: boolean } | null;
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
  /** Lists, quotes and the signature block; all on unless turned off. */
  features?: EditorFeatures;
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
  features,
  className,
}: ComposeEditorProps) {
  const handlers = useRef({ onChange, onFiles, onLinkShortcut, onImported });
  handlers.current = { onChange, onFiles, onLinkShortcut, onImported };
  const imported = useRef(false);
  const importing = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: composeExtensions(features),
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
          "[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs",
          "[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-xs",
          // The signature: a muted `-- ` above it only when it is last; nothing when empty.
          "[&_.makosh-signature:empty]:hidden [&_.makosh-signature:last-child]:before:block",
          "[&_.makosh-signature:last-child]:before:text-muted-foreground [&_.makosh-signature:last-child]:before:content-['--_']",
        ),
      },
      transformPastedHTML: (html) => cleanPastedHtml(html),
      handlePaste: (_view, event) => {
        const files = filesOf(event.clipboardData);
        if (files.length === 0) {
          // Plain text with a fenced block becomes a code block (slice 3g).
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          const html = event.clipboardData?.getData("text/html") ?? "";
          const current = editorRef.current;
          if (html !== "" || plain === "" || current === null || current.schema.nodes.codeBlock === undefined) return false;
          const content = fencedPaste(plain);
          if (content === null) return false;
          event.preventDefault();
          current.chain().insertContent(content).run();
          return true;
        }
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
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const current = editorRef.current;
          if (current !== null && fenceEnter(current)) {
            event.preventDefault();
            return true;
          }
        }
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

  editorRef.current = editor;
  useEffect(() => {
    if (editor === null) return;
    onReady(editor);
    if (importFrom !== null && !imported.current) {
      imported.current = true;
      importing.current = true;
      try {
        importHtml(editor, importFrom.html, importFrom.into, importFrom.stripSignature === true);
      } finally {
        importing.current = false;
      }
      handlers.current.onImported?.(editor.getJSON());
    }
    // onReady and importFrom are read once per editor.
  }, [editor]);

  return <EditorContent editor={editor} className={cn("min-h-0", className)} />;
}
