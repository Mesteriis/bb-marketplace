// One ChatGPT window and the text BB proposes for it. A proposal only shows
// the text in the window's own panel; it is written into a draft when the
// user presses "Вставить в черновик" there. The conversation is chosen when
// the proposal arrives (or when the user asks to choose again) and is held by
// the same transfer session the Browser version used: any navigation after
// the choice, a reload or a different address cancels the write.
import { describeTarget } from "./target.ts";
import {
  createTransfer,
  describeRefusal,
  MAX_TEXT_LENGTH,
  type PagePort,
  type TransferSession,
  type TransferState,
  type WriteOutcome,
} from "./transfer.ts";
import type { PanelAction, PanelView } from "./window-protocol.ts";

export interface WindowPort extends PagePort {
  showPanel(view: PanelView): void;
}

export type ProposalSource = "message-selection" | "manual";

/** What BB may learn about the window: no text, no conversation. */
export type WindowOutcome = "handed-off" | "unknown" | "refused" | "copied" | "cancelled";

export interface WindowStatus {
  proposal: "none" | "waiting" | "writing";
  last: { proposalId: string; outcome: WindowOutcome } | null;
}

export type ProposeResult =
  | { ok: true; proposalId: string }
  | { ok: false; reason: "busy" | "empty-text" | "text-too-long" };

export interface WindowSession {
  urlChanged(url: string): void;
  propose(text: string, source: ProposalSource): ProposeResult;
  pressed(action: PanelAction): Promise<void>;
  copied(ok: boolean): void;
  closed(): void;
  status(): WindowStatus;
  dispose(): void;
}

export interface WindowSessionOptions {
  port: WindowPort;
  newId(): string;
  timeoutMs?: number;
  /** Called after every change of `status()`. */
  onChange(): void;
}

const HIDDEN: PanelView = {
  visible: false,
  status: "",
  text: "",
  canInsert: false,
  canRebind: false,
  canCopy: false,
  busy: false,
  dismissLabel: "Отмена",
};

const SOURCE_TEXT: Record<ProposalSource, string> = {
  "message-selection": "фрагмент сообщения из BB",
  manual: "текст, введённый в BB",
};

interface Proposal {
  id: string;
  text: string;
  source: ProposalSource;
}

export function createWindowSession(options: WindowSessionOptions): WindowSession {
  const { port } = options;
  let url = "";
  let proposal: Proposal | null = null;
  let transfer: TransferSession | null = null;
  let stopWatching: (() => void) | null = null;
  let writing = false;
  let note: string | null = null;
  let last: WindowStatus["last"] = null;
  let disposed = false;

  function statusText(state: TransferState, current: Proposal): string {
    const from = "Источник: " + SOURCE_TEXT[current.source] + ", знаков: " + String(current.text.length) + ". ";
    switch (state.kind) {
      case "binding":
        return from + "Проверяю беседу в окне…";
      case "ready":
        return from + "Адресат: " + describeTarget(state.target) + ". Текст будет добавлен в конец черновика; отправляете вы.";
      case "writing":
        return "Передаю текст в поле ввода…";
      case "handed-off":
        return "Текст передан в поле ввода: " + describeTarget(state.target) + ". Проверьте черновик и отправьте сами.";
      case "unknown":
        return "Результат неизвестен: страница не ответила. Проверьте черновик (" + describeTarget(state.target) + ") перед любым повтором.";
      case "unbound":
        return state.refusal === null
          ? from + "Беседа не выбрана."
          : from + "Вставка недоступна. " + describeRefusal(state.refusal) + " Можно скопировать текст и вставить его вручную.";
    }
  }

  function render(): void {
    if (disposed) return;
    if (proposal === null || transfer === null) {
      port.showPanel(HIDDEN);
      return;
    }
    const state = transfer.getState();
    const finished = state.kind === "handed-off" || state.kind === "unknown";
    port.showPanel({
      visible: true,
      status: note === null ? statusText(state, proposal) : note,
      text: finished ? "" : proposal.text,
      canInsert: state.kind === "ready",
      canRebind: state.kind === "unbound",
      canCopy: !finished && state.kind !== "writing",
      busy: state.kind === "binding" || state.kind === "writing",
      dismissLabel: finished ? "Закрыть" : "Отмена",
    });
  }

  function changed(): void {
    render();
    options.onChange();
  }

  function dropTransfer(): void {
    stopWatching?.();
    stopWatching = null;
    transfer?.dispose();
    transfer = null;
  }

  function finish(outcome: WindowOutcome): void {
    if (proposal !== null) last = { proposalId: proposal.id, outcome };
  }

  // A proposal that ends without any outcome of its own was cancelled.
  function cancelIfOpen(): void {
    if (proposal !== null && !writing && last?.proposalId !== proposal.id) finish("cancelled");
  }

  return {
    urlChanged(next) {
      url = next;
      transfer?.hostUrlChanged(next);
    },

    propose(text, source) {
      if (writing) return { ok: false, reason: "busy" };
      if (text.length === 0) return { ok: false, reason: "empty-text" };
      if (text.length > MAX_TEXT_LENGTH) return { ok: false, reason: "text-too-long" };
      cancelIfOpen();
      dropTransfer();
      proposal = { id: options.newId(), text, source };
      note = null;
      const next = createTransfer({ page: port, clipboard: { writeText: async () => false }, newNonce: options.newId, timeoutMs: options.timeoutMs });
      transfer = next;
      stopWatching = next.subscribe(changed);
      void next.bind(url);
      changed();
      return { ok: true, proposalId: proposal.id };
    },

    async pressed(action) {
      if (disposed || proposal === null || transfer === null) return;
      if (action === "dismiss") {
        cancelIfOpen();
        proposal = null;
        dropTransfer();
        changed();
        return;
      }
      if (action === "rebind") {
        note = null;
        void transfer.bind(url);
        return;
      }
      // insert: one write at a time across proposals; the outcome is kept
      // even when the panel was dismissed while the page was answering.
      if (writing || transfer.getState().kind !== "ready") return;
      const used = proposal;
      const session = transfer;
      writing = true;
      note = null;
      options.onChange();
      let outcome: WriteOutcome = "unknown";
      try {
        outcome = await session.confirm(used.text);
      } finally {
        writing = false;
      }
      last = { proposalId: used.id, outcome: outcome === "ignored" ? "refused" : outcome };
      if (proposal === used && (outcome === "handed-off" || outcome === "unknown")) {
        // The text may be in a draft now: it cannot be inserted again.
        proposal = { ...used, text: "" };
      }
      changed();
    },

    copied(ok) {
      if (disposed || proposal === null) return;
      note = ok ? "Текст скопирован. Вставьте его в поле ChatGPT сами: ⌘V." : "Не удалось записать буфер обмена.";
      if (ok) finish("copied");
      changed();
    },

    closed() {
      cancelIfOpen();
      proposal = null;
      dropTransfer();
      options.onChange();
    },

    status() {
      return { proposal: writing ? "writing" : proposal === null || proposal.text === "" ? "none" : "waiting", last };
    },

    dispose() {
      disposed = true;
      dropTransfer();
      proposal = null;
    },
  };
}
