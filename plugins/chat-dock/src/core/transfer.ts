// One transfer of text into one conversation's draft. The session binds to
// the conversation the host reports, withdraws the binding when that address
// changes, and writes at most once. Every step that starts a write or a copy
// is a method the UI calls from a user's own action; nothing here runs on a
// timer or retries.
import { bindExpression, parseBindReport, parseWriteReport, writeExpression, type WriteStatus } from "./page-script.ts";
import { sameTarget, targetFromUrl, type ConversationTarget, type TargetRefusal } from "./target.ts";

/** Script access to the tab's top-level document. */
export interface PagePort {
  evaluate(expression: string): Promise<unknown>;
}

/** The system clipboard. Written only by `copy`. */
export interface ClipboardPort {
  writeText(text: string): Promise<boolean>;
}

export const MAX_TEXT_LENGTH = 100_000;

export type Refusal =
  | TargetRefusal
  /** This client cannot script the tab (not the desktop app). */
  | "page-unavailable"
  /** The document does not match the address the host reports. */
  | "address-mismatch"
  /** The conversation changed after it was chosen. */
  | "conversation-changed"
  | Exclude<WriteStatus, "handed-off">
  | "empty-text"
  | "text-too-long";

export type TransferState =
  /** No conversation is chosen. `refusal` says why the last attempt ended. */
  | { kind: "unbound"; refusal: Refusal | null }
  | { kind: "binding" }
  /** The conversation is chosen; nothing has been written. */
  | { kind: "ready"; target: ConversationTarget }
  | { kind: "writing"; target: ConversationTarget }
  /** The editor took the text. Whether the draft shows it is for the user to see. */
  | { kind: "handed-off"; target: ConversationTarget }
  /** The request was sent and no answer came. The draft may or may not have the text. */
  | { kind: "unknown"; target: ConversationTarget };

export type WriteOutcome =
  /** Nothing was sent to the page: no chosen conversation, or a write already ran. */
  | "ignored"
  /** The page refused or the request was refused before it; nothing was written. */
  | "refused"
  | "handed-off"
  /** Sent, no usable answer: the draft may or may not have the text. */
  | "unknown";

export interface TransferSession {
  getState(): TransferState;
  subscribe(listener: () => void): () => void;
  /** Choose the conversation the tab shows now. Call only from a user action. */
  bind(hostUrl: string): Promise<void>;
  /** Tell the session the address the host reports for the tab. */
  hostUrlChanged(hostUrl: string): void;
  /**
   * Write `text` into the chosen conversation's draft. Call only from a user
   * action. The outcome is returned even when the session was dropped while
   * the page was answering, so the caller can still tell the user.
   */
  confirm(text: string): Promise<WriteOutcome>;
  /** Put `text` on the system clipboard. Call only from a user action. */
  copy(text: string): Promise<boolean>;
  /** Drop the binding and stop reporting. */
  dispose(): void;
}

export interface TransferOptions {
  page: PagePort | null;
  clipboard: ClipboardPort;
  newNonce(): string;
  /** How long to wait for the page's answer before the result is unknown. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol("timed-out");

function withTimeout(work: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createTransfer(options: TransferOptions): TransferSession {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  let state: TransferState = { kind: "unbound", refusal: null };
  let nonce: string | null = null;
  // The conversation a bind in flight is asking for.
  let pending: ConversationTarget | null = null;
  let disposed = false;
  // Counts binds and revocations so a late answer cannot revive an old choice.
  let epoch = 0;

  function set(next: TransferState): void {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function refuse(refusal: Refusal): void {
    nonce = null;
    pending = null;
    epoch += 1;
    set({ kind: "unbound", refusal });
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async bind(hostUrl) {
      if (disposed || state.kind === "binding" || state.kind === "writing") return;
      const wanted = targetFromUrl(hostUrl);
      if (!wanted.ok) return refuse(wanted.reason);
      const page = options.page;
      if (page === null) return refuse("page-unavailable");

      const attempt = (epoch += 1);
      const candidate = options.newNonce();
      nonce = null;
      pending = wanted.target;
      set({ kind: "binding" });
      let answer: unknown;
      try {
        answer = await withTimeout(page.evaluate(bindExpression({ nonce: candidate })), timeoutMs);
      } catch {
        answer = TIMED_OUT;
      }
      if (disposed || attempt !== epoch) return;
      const report = answer === TIMED_OUT ? null : parseBindReport(answer);
      if (report === null) return refuse("page-unavailable");
      if (!report.top) return refuse("not-top");
      if (report.origin !== wanted.target.origin || report.path !== wanted.target.path) {
        return refuse("address-mismatch");
      }
      nonce = candidate;
      pending = null;
      set({ kind: "ready", target: wanted.target });
    },

    hostUrlChanged(hostUrl) {
      if (disposed) return;
      const chosen = state.kind === "ready" ? state.target : state.kind === "binding" ? pending : null;
      if (chosen === null) return;
      const now = targetFromUrl(hostUrl);
      if (!now.ok || !sameTarget(now.target, chosen)) refuse("conversation-changed");
    },

    async confirm(text) {
      // A second click lands here while `writing`, or after the single write
      // ended: both are ignored, so the text cannot be written twice.
      if (disposed || state.kind !== "ready") return "ignored";
      const page = options.page;
      const target = state.target;
      const spent = nonce;
      if (page === null || spent === null) {
        refuse("page-unavailable");
        return "refused";
      }
      if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
        refuse(text.length === 0 ? "empty-text" : "text-too-long");
        return "refused";
      }

      nonce = null;
      epoch += 1;
      set({ kind: "writing", target });
      let answer: unknown;
      try {
        answer = await withTimeout(
          page.evaluate(writeExpression({ nonce: spent, origin: target.origin, path: target.path, text })),
          timeoutMs,
        );
      } catch {
        answer = TIMED_OUT;
      }
      // From here the outcome is reported even to a dropped session: the page
      // may have taken the text whether or not anyone is still listening.
      const report = answer === TIMED_OUT ? null : parseWriteReport(answer);
      if (report === null) {
        set({ kind: "unknown", target });
        return "unknown";
      }
      if (report.status === "handed-off") {
        set({ kind: "handed-off", target });
        return "handed-off";
      }
      set({ kind: "unbound", refusal: report.status });
      return "refused";
    },

    async copy(text) {
      if (disposed || text.length === 0) return false;
      return options.clipboard.writeText(text);
    },

    dispose() {
      disposed = true;
      nonce = null;
      pending = null;
      epoch += 1;
      listeners.clear();
    },
  };
}

const REFUSAL_TEXT: Record<Refusal, string> = {
  "invalid-url": "Адрес вкладки не распознан.",
  "not-chatgpt": "Во вкладке открыт не chatgpt.com.",
  "no-conversation": "Во вкладке нет существующей беседы: это новый чат, вход или другая страница ChatGPT.",
  "page-unavailable": "Этот клиент BB не даёт доступа к странице вкладки. Автовставка работает только в BB Desktop.",
  "address-mismatch": "Страница во вкладке не совпадает с адресом, который показывает BB.",
  "conversation-changed": "Беседа во вкладке сменилась после выбора. Текст никуда не вставлен.",
  "binding-lost": "Страница была перезагружена или заменена после выбора беседы. Текст никуда не вставлен.",
  "not-top": "Редактор находится не в основном документе вкладки. Текст никуда не вставлен.",
  "origin-changed": "Вкладка ушла с chatgpt.com. Текст никуда не вставлен.",
  "editor-unknown": "Поле ввода беседы не найдено или не распознано. Текст никуда не вставлен.",
  "editor-rejected": "Поле ввода не приняло текст. Текст никуда не вставлен.",
  "empty-text": "Текст пуст.",
  "text-too-long": "Текст длиннее 100 000 знаков.",
};

export function describeRefusal(refusal: Refusal): string {
  return REFUSAL_TEXT[refusal];
}
