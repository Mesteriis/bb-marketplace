// The text the user picked in BB and has not handed over yet. It lives in
// memory only: never in storage, a URL, a log or a tab's saved parameters.

export type ContextSource =
  /** Text the user highlighted in an assistant message of a BB thread. */
  | { kind: "message-selection"; threadId: string }
  /** Text the user typed or pasted into the preview themselves. */
  | { kind: "manual" };

export interface StagedContext {
  text: string;
  source: ContextSource;
}

export interface Staging {
  get(): StagedContext | null;
  subscribe(listener: () => void): () => void;
  /** Replace the staged text with a new pick. */
  stage(context: StagedContext): void;
  /** The user edited the preview: keep the source, change the text. */
  edit(text: string): void;
  clear(): void;
  /** True while a transfer of the staged text to a page has no known outcome. */
  transferring(): boolean;
  /**
   * Reserve the staged text for one transfer. False when another transfer is
   * still unresolved: the caller must not send. One per loaded plugin, so a
   * reopened panel or another tab's panel sees the same reservation.
   */
  beginTransfer(): boolean;
  /** The transfer's outcome is known. `mayBeInDraft` drops the text that was sent. */
  endTransfer(sent: string, mayBeInDraft: boolean): void;
}

export function createStaging(): Staging {
  const listeners = new Set<() => void>();
  let current: StagedContext | null = null;
  let inFlight = false;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(next: StagedContext | null): void {
    current = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stage(context) {
      set({ text: context.text, source: context.source });
    },
    edit(text) {
      if (current === null) {
        if (text.length > 0) set({ text, source: { kind: "manual" } });
        return;
      }
      if (text !== current.text) set({ text, source: current.source });
    },
    clear() {
      if (current !== null) set(null);
    },
    transferring: () => inFlight,
    beginTransfer() {
      if (inFlight) return false;
      inFlight = true;
      notify();
      return true;
    },
    endTransfer(sent, mayBeInDraft) {
      inFlight = false;
      // A text picked while the page was answering is a new one: keep it.
      if (mayBeInDraft && current !== null && current.text === sent) current = null;
      notify();
    },
  };
}

export function describeSource(source: ContextSource): string {
  return source.kind === "message-selection"
    ? "Выделенный фрагмент сообщения ассистента в треде BB"
    : "Текст, введённый вручную";
}
