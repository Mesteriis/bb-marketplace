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
  /** Drop the staged text only if it is still exactly `sent`. */
  clearIf(sent: string): void;
}

export function createStaging(): Staging {
  const listeners = new Set<() => void>();
  let current: StagedContext | null = null;
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
    clearIf(sent) {
      // A text picked or edited while the window was answering is a new one: keep it.
      if (current !== null && current.text === sent) set(null);
    },
  };
}

export function describeSource(source: ContextSource): string {
  return source.kind === "message-selection"
    ? "Выделенный фрагмент сообщения ассистента в треде BB"
    : "Текст, введённый вручную";
}
