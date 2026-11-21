// The two functions that run inside the Browser tab's document. The host
// evaluates them from source text, so each must be self-contained: no imports,
// no module-scope names, no helpers. They run in the host's isolated world,
// which page scripts cannot read or change.
//
// Neither function returns or sends anything the page shows: no draft text,
// no messages, no titles. A report carries only the document's own address
// and a fixed status word.

export interface BindArgs {
  nonce: string;
}

export interface BindReport {
  top: boolean;
  origin: string;
  path: string;
}

export interface WriteArgs {
  nonce: string;
  origin: string;
  path: string;
  text: string;
}

export type WriteStatus =
  /** The editor took the text. The draft is not read back, so this is not "inserted". */
  | "handed-off"
  /** The document was reloaded or replaced, or this permission was already used. */
  | "binding-lost"
  | "not-top"
  | "origin-changed"
  | "conversation-changed"
  /** No editor, several editors, or one this plugin does not know. */
  | "editor-unknown"
  /** The editor refused the text; nothing was written. */
  | "editor-rejected";

export interface WriteReport {
  status: WriteStatus;
}

/**
 * Marks this document as the one the user chose. The mark lives in the
 * document's isolated world and dies with the document, so a reload or a
 * redirect withdraws the permission without any timer.
 */
export function bindInPage(args: BindArgs): BindReport {
  const scope = globalThis as unknown as { __bbChatDock?: { nonce: string } };
  scope.__bbChatDock = { nonce: args.nonce };
  return { top: window.top === window, origin: location.origin, path: location.pathname };
}

/**
 * Checks the addressee and appends the text in one synchronous step: no
 * navigation can happen between the check and the write. The permission is
 * spent before anything else, so a second call with the same nonce refuses.
 */
export function writeInPage(args: WriteArgs): WriteReport {
  const scope = globalThis as unknown as { __bbChatDock?: { nonce: string } };
  const mark = scope.__bbChatDock;
  delete scope.__bbChatDock;
  if (mark === undefined || mark === null || mark.nonce !== args.nonce) return { status: "binding-lost" };
  if (window.top !== window) return { status: "not-top" };
  if (location.origin !== args.origin) return { status: "origin-changed" };
  if (location.pathname !== args.path) return { status: "conversation-changed" };

  const editors = document.querySelectorAll("#prompt-textarea");
  if (editors.length !== 1) return { status: "editor-unknown" };
  const editor = editors[0] as HTMLElement;
  if (!editor.isConnected || editor.closest("[hidden], [inert], [aria-hidden='true']") !== null) {
    return { status: "editor-unknown" };
  }

  if (editor instanceof HTMLTextAreaElement) {
    if (editor.disabled || editor.readOnly) return { status: "editor-unknown" };
    // Collapse the caret at the end without reading the draft: the browser
    // clamps an oversized offset to the end of the value.
    editor.setSelectionRange(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    editor.setRangeText(args.text);
    editor.setSelectionRange(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: args.text }));
    return { status: "handed-off" };
  }

  if (editor.getAttribute("contenteditable") !== "true") return { status: "editor-unknown" };
  const selection = window.getSelection();
  if (selection === null) return { status: "editor-unknown" };
  // The caret goes to the end, so a part the user selected in the draft is
  // deselected instead of replaced.
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  editor.focus();

  if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
    // A paste event carrying its own data: the system clipboard is not touched.
    const data = new DataTransfer();
    data.setData("text/plain", args.text);
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    if (!editor.dispatchEvent(paste)) return { status: "handed-off" };
  }
  if (typeof document.execCommand === "function" && document.execCommand("insertText", false, args.text)) {
    return { status: "handed-off" };
  }
  return { status: "editor-rejected" };
}

export function bindExpression(args: BindArgs): string {
  return "(" + bindInPage.toString() + ")(" + JSON.stringify(args) + ")";
}

export function writeExpression(args: WriteArgs): string {
  return "(" + writeInPage.toString() + ")(" + JSON.stringify(args) + ")";
}

const WRITE_STATUSES: readonly WriteStatus[] = [
  "handed-off",
  "binding-lost",
  "not-top",
  "origin-changed",
  "conversation-changed",
  "editor-unknown",
  "editor-rejected",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null for anything that is not exactly a bind report. */
export function parseBindReport(value: unknown): BindReport | null {
  if (!isRecord(value)) return null;
  const { top, origin, path } = value;
  if (typeof top !== "boolean" || typeof origin !== "string" || typeof path !== "string") return null;
  return { top, origin, path };
}

/** Null for anything that is not exactly a write report. */
export function parseWriteReport(value: unknown): WriteReport | null {
  if (!isRecord(value)) return null;
  const status = WRITE_STATUSES.find((known) => known === value.status);
  return status === undefined ? null : { status };
}
