// The functions that run inside the Browser tab's document. The host
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
  /** False when the page cannot report its own navigations; binding is then refused. */
  tracked: boolean;
}

export interface WriteArgs {
  nonce: string;
  origin: string;
  path: string;
  text: string;
}

export interface RevokeArgs {
  nonce: string;
}

export type WriteStatus =
  /** The editor took the text. The draft is not read back, so this is not "inserted". */
  | "handed-off"
  /** The document was reloaded or replaced, or this permission was already used or withdrawn. */
  | "binding-lost"
  | "not-top"
  | "origin-changed"
  /** The address differs, or the page navigated at all since the conversation was chosen. */
  | "conversation-changed"
  /** No editor, several editors, or one this plugin does not know. */
  | "editor-unknown"
  /** The editor refused the text; nothing was written. */
  | "editor-rejected"
  /** The editor was asked and gave no clear answer: the draft may or may not have the text. */
  | "unconfirmed";

export interface WriteReport {
  status: WriteStatus;
}

/**
 * Marks this document as the one the user chose and starts counting its
 * navigations. The mark lives in the document's isolated world and dies with
 * the document, so a reload or a redirect withdraws the permission without
 * any timer. Any navigation after this moment, including one that comes back
 * to the same address, spends the permission too.
 */
export function bindInPage(args: BindArgs): BindReport {
  const scope = globalThis as unknown as {
    __bbChatDock?: { nonce: string; moved: boolean; stop: () => void };
    navigation?: EventTarget;
  };
  scope.__bbChatDock?.stop();
  delete scope.__bbChatDock;
  const report = { top: window.top === window, origin: location.origin, path: location.pathname, tracked: false };
  const history = scope.navigation;
  if (history === undefined || history === null || typeof history.addEventListener !== "function") return report;
  const mark = {
    nonce: args.nonce,
    moved: false,
    stop: () => history.removeEventListener("currententrychange", onMove),
  };
  function onMove(): void {
    mark.moved = true;
  }
  history.addEventListener("currententrychange", onMove);
  scope.__bbChatDock = mark;
  report.tracked = true;
  return report;
}

/** Withdraws the permission `bindInPage` gave, if it is still this one. */
export function revokeInPage(args: RevokeArgs): boolean {
  const scope = globalThis as unknown as { __bbChatDock?: { nonce: string; stop: () => void } };
  const mark = scope.__bbChatDock;
  if (mark === undefined || mark === null || mark.nonce !== args.nonce) return false;
  mark.stop();
  delete scope.__bbChatDock;
  return true;
}

/**
 * Checks the addressee and appends the text. The permission is spent before
 * anything else, so a second call with the same nonce refuses. Focusing the
 * editor runs the page's own handlers, so it happens first and every check
 * comes after it: between the last check and the write no page code runs.
 */
export function writeInPage(args: WriteArgs): WriteReport {
  const scope = globalThis as unknown as { __bbChatDock?: { nonce: string; moved: boolean; stop: () => void } };
  const mark = scope.__bbChatDock;
  delete scope.__bbChatDock;
  if (mark === undefined || mark === null || mark.nonce !== args.nonce) return { status: "binding-lost" };

  const before = document.querySelectorAll("#prompt-textarea");
  const editor = before.length === 1 ? (before[0] as HTMLElement) : null;
  const rich = editor !== null && !(editor instanceof HTMLTextAreaElement);
  if (editor !== null && rich && editor.getAttribute("contenteditable") === "true") editor.focus();

  // Nothing below hands control to the page until the text is written.
  mark.stop();
  if (mark.moved) return { status: "conversation-changed" };
  if (window.top !== window) return { status: "not-top" };
  if (location.origin !== args.origin) return { status: "origin-changed" };
  if (location.pathname !== args.path) return { status: "conversation-changed" };

  const editors = document.querySelectorAll("#prompt-textarea");
  if (editor === null || editors.length !== 1 || editors[0] !== editor) return { status: "editor-unknown" };
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

  // One mechanism per write, never a second attempt: a fallback after an
  // unclear answer could put the text into the draft twice.
  if (typeof document.execCommand === "function") {
    // Works on the DOM selection just set, so it appends at the caret.
    if (document.execCommand("insertText", false, args.text)) return { status: "handed-off" };
    // The editor may have handled the input itself and cancelled the default.
    return { status: "unconfirmed" };
  }
  if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
    // A paste event carrying its own data: the system clipboard is not touched.
    const data = new DataTransfer();
    data.setData("text/plain", args.text);
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    return { status: editor.dispatchEvent(paste) ? "editor-rejected" : "handed-off" };
  }
  return { status: "editor-rejected" };
}

export function bindExpression(args: BindArgs): string {
  return "(" + bindInPage.toString() + ")(" + JSON.stringify(args) + ")";
}

export function revokeExpression(args: RevokeArgs): string {
  return "(" + revokeInPage.toString() + ")(" + JSON.stringify(args) + ")";
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
  "unconfirmed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null for anything that is not exactly a bind report. */
export function parseBindReport(value: unknown): BindReport | null {
  if (!isRecord(value)) return null;
  const { top, origin, path, tracked } = value;
  if (typeof top !== "boolean" || typeof origin !== "string" || typeof path !== "string") return null;
  if (typeof tracked !== "boolean") return null;
  return { top, origin, path, tracked };
}

/** Null for anything that is not exactly a write report. */
export function parseWriteReport(value: unknown): WriteReport | null {
  if (!isRecord(value)) return null;
  const status = WRITE_STATUSES.find((known) => known === value.status);
  return status === undefined ? null : { status };
}
