// The ChatGPT page of BB's navigation. ChatGPT itself runs in a separate
// window with its own sign-in; this page prepares the text, shows the
// window's state and hands the text over. Inserting happens only after the
// user confirms in the window.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WindowStatusView } from "../core/window-status.ts";
import { ContextPreview } from "./context-preview.tsx";
import { BUTTON_GHOST, BUTTON_OUTLINE, BUTTON_PRIMARY, isTrustedEvent, type DockServices, type IsUserAction } from "./services.ts";
import { useStaged } from "./use-store.ts";

interface DockPageProps {
  services: DockServices;
  /** The window's latest status; null until it is known. */
  status: WindowStatusView | null;
  isUserAction?: IsUserAction;
}

function describeStatus(status: WindowStatusView | null): string {
  if (status === null) return "Состояние окна неизвестно.";
  switch (status.window) {
    case "closed":
      return "Окно ChatGPT закрыто.";
    case "building":
      return "Окно ChatGPT собирается на этом Mac. Первый раз это занимает до минуты.";
    case "unavailable":
      return "Окно ChatGPT недоступно. " + (status.reason ?? "");
    case "open":
      if (status.proposal === "waiting") return "Окно открыто. Текст ждёт подтверждения в окне.";
      if (status.proposal === "writing") return "Окно открыто. Текст передаётся в поле ввода.";
      return "Окно ChatGPT открыто.";
  }
}

const OUTCOME_TEXT = {
  "handed-off": "Последняя передача: текст передан в поле ввода. Проверьте черновик и отправьте сами.",
  unknown: "Последняя передача: результат неизвестен. Проверьте черновик перед повтором.",
  refused: "Последняя передача: вставка отменена, текст никуда не записан.",
  copied: "Последняя передача: текст скопирован в окне, вставьте его сами.",
  cancelled: "Последняя передача отменена в окне.",
} as const;

export function DockPage({ services, status, isUserAction = isTrustedEvent }: DockPageProps) {
  const { staging, window, copyText, notify } = services;
  const staged = useStaged(staging);
  const [busy, setBusy] = useState(false);
  const sent = useRef<{ proposalId: string; text: string } | null>(null);
  const hasText = staged !== null && staged.text.length > 0;

  // Once the window reports that the proposal may be in a draft, the same
  // text is dropped here so it cannot be handed over twice by mistake.
  useEffect(() => {
    const last = status?.last;
    const mine = sent.current;
    if (last === undefined || last === null || mine === null || last.proposalId !== mine.proposalId) return;
    if (last.outcome === "handed-off" || last.outcome === "unknown") staging.clearIf(mine.text);
    if (last.outcome !== "copied") sent.current = null;
  }, [status, staging]);

  async function open(event: MouseEvent) {
    if (!isUserAction(event) || busy) return;
    setBusy(true);
    try {
      const next = await window.open();
      if (next.window === "unavailable") notify("error", next.reason ?? "Окно ChatGPT недоступно.");
    } catch {
      notify("error", "Не удалось открыть окно ChatGPT.");
    } finally {
      setBusy(false);
    }
  }

  async function handOver(event: MouseEvent) {
    if (!isUserAction(event) || busy || staged === null || staged.text.length === 0) return;
    setBusy(true);
    const text = staged.text;
    try {
      const result = await window.propose(text, staged.source.kind);
      if (result.ok) {
        sent.current = { proposalId: result.proposalId, text };
        notify("info", "Текст показан в окне ChatGPT. Проверьте беседу и подтвердите вставку там.");
      } else if (result.reason === "busy") {
        notify("error", "Окно ещё передаёт предыдущий текст. Дождитесь результата.");
      } else if (result.reason === "window-unavailable") {
        notify("error", "Окно ChatGPT ещё не готово. Повторите, когда оно откроется.");
      } else {
        notify("error", "Текст пуст или длиннее 100 000 знаков.");
      }
    } catch {
      notify("error", "Не удалось передать текст окну ChatGPT.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(event: MouseEvent) {
    if (!isUserAction(event) || staged === null || staged.text.length === 0) return;
    const ok = await copyText(staged.text);
    notify(ok ? "success" : "error", ok ? "Контекст скопирован. Вставьте его в поле ChatGPT сами: ⌘V." : "Не удалось записать буфер обмена.");
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <section aria-labelledby="chat-dock-window" className="rounded-md border border-border p-3">
          <h2 id="chat-dock-window" className="text-sm font-semibold">
            Окно ChatGPT
          </h2>
          <p role="status" aria-live="polite" className="mt-1 text-sm text-muted-foreground">
            {describeStatus(status)}
          </p>
          {status?.last !== null && status?.last !== undefined && (
            <p className="mt-1 text-xs text-muted-foreground">{OUTCOME_TEXT[status.last.outcome]}</p>
          )}
          <p className="mt-3 text-xs leading-relaxed">
            ChatGPT открывается в отдельном окне без адресной строки. У окна свой вход, отдельный от Browser в BB, и
            инструменты агентов BB (<code>bb browser</code>) до него не дотягиваются. Программы с полными правами в macOS,
            например средства автоматизации интерфейса, это окно видеть могут.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_OUTLINE} disabled={busy} onClick={open}>
              Открыть окно ChatGPT
            </button>
          </div>
        </section>

        <section aria-label="Подготовленный контекст" className="flex flex-col gap-3">
          <ContextPreview staging={staging} rows={12} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_PRIMARY} disabled={!hasText || busy || status?.proposal === "writing"} onClick={handOver}>
              Передать в окно ChatGPT
            </button>
            <button type="button" className={BUTTON_OUTLINE} disabled={!hasText} onClick={copy}>
              Скопировать контекст
            </button>
            <button
              type="button"
              className={BUTTON_GHOST}
              disabled={staged === null}
              onClick={(event) => {
                if (isUserAction(event)) staging.clear();
              }}
            >
              Очистить
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Текст хранится только в памяти этого окна BB. Окно ChatGPT покажет его вместе с адресатом, а вставит в
            черновик только после вашего нажатия «Вставить в черновик» в самом окне. Отправляете сообщение вы.
          </p>
        </section>
      </div>
    </div>
  );
}
