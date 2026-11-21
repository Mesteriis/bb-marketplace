// A controlled stand-in for a chat site: two conversations in one document,
// a draft per conversation, and a counter of sent messages. It proves the
// plugin's rules on a page we own. It says nothing about the real ChatGPT.

export const PATH_A = "/c/aaaaaaaa-0000-4000-8000-00000000000a";
export const PATH_B = "/c/bbbbbbbb-0000-4000-8000-00000000000b";
export const URL_A = "https://chatgpt.com" + PATH_A;
export const URL_B = "https://chatgpt.com" + PATH_B;

export type EditorKind = "textarea" | "contenteditable";

export interface Fixture {
  /** Switch the conversation inside the same document, as a single-page app does. */
  go(path: string): void;
  draft(path: string): string;
  sent(): number;
  editor(): HTMLElement;
  /** Replace the document's script state, as a reload does. */
  reload(): void;
  removeEditor(): void;
  dispose(): void;
}

class FakeDataTransfer {
  private readonly items = new Map<string, string>();
  setData(type: string, value: string): void {
    this.items.set(type, value);
  }
  getData(type: string): string {
    return this.items.get(type) ?? "";
  }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer }) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

export function mountFixture(kind: EditorKind, drafts: Record<string, string> = {}): Fixture {
  const scope = globalThis as unknown as Record<string, unknown>;
  const hadTransfer = "DataTransfer" in scope;
  const hadClipboard = "ClipboardEvent" in scope;
  if (!hadTransfer) scope.DataTransfer = FakeDataTransfer;
  if (!hadClipboard) scope.ClipboardEvent = FakeClipboardEvent;

  const stored = new Map<string, string>(Object.entries(drafts));
  let sent = 0;
  history.replaceState(null, "", PATH_A);

  const form = document.createElement("form");
  const editor = kind === "textarea" ? document.createElement("textarea") : document.createElement("div");
  editor.id = "prompt-textarea";
  if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
  form.append(editor);
  document.body.append(form);

  const read = (): string => (editor instanceof HTMLTextAreaElement ? editor.value : (editor.textContent ?? ""));
  const show = (text: string): void => {
    if (editor instanceof HTMLTextAreaElement) editor.value = text;
    else editor.textContent = text;
  };
  show(stored.get(location.pathname) ?? "");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sent += 1;
  });
  editor.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") sent += 1;
  });
  editor.addEventListener("paste", (event) => {
    const data = (event as unknown as FakeClipboardEvent).clipboardData;
    if (data === null || editor instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    editor.textContent = (editor.textContent ?? "") + data.getData("text/plain");
  });

  return {
    go(path) {
      stored.set(location.pathname, read());
      history.pushState(null, "", path);
      show(stored.get(path) ?? "");
    },
    draft(path) {
      return path === location.pathname ? read() : (stored.get(path) ?? "");
    },
    sent: () => sent,
    editor: () => editor,
    reload() {
      delete (globalThis as unknown as { __bbChatDock?: unknown }).__bbChatDock;
    },
    removeEditor() {
      editor.remove();
    },
    dispose() {
      form.remove();
      delete (globalThis as unknown as { __bbChatDock?: unknown }).__bbChatDock;
      if (!hadTransfer) delete scope.DataTransfer;
      if (!hadClipboard) delete scope.ClipboardEvent;
    },
  };
}

/** Evaluates source text in the document, as the host's `evaluate` does. */
export function evaluateInDocument(expression: string): unknown {
  return (0, eval)(expression);
}
