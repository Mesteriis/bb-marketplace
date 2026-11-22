// The ChatGPT page of BB's navigation. ChatGPT itself runs in a separate
// native window with its own sign-in, placed exactly on the area this page
// reserves for it, so it reads as part of the page. The column beside it
// prepares the text and hands it over; inserting happens only after the user
// confirms in the ChatGPT area.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { WindowStatusView } from "../core/window-status.ts";
import { ContextPreview } from "./context-preview.tsx";
import { BUTTON_GHOST, BUTTON_OUTLINE, BUTTON_PRIMARY, isTrustedEvent, type DockServices, type IsUserAction } from "./services.ts";
import { useAttachment } from "./use-attachment.ts";
import { useStaged } from "./use-store.ts";

interface DockPageProps {
  services: DockServices;
  /** The window's latest status; null until it is known. */
  status: WindowStatusView | null;
  isUserAction?: IsUserAction;
}

function describeStatus(status: WindowStatusView | null): string {
  if (status === null) return "Открываю ChatGPT…";
  switch (status.window) {
    case "closed":
      return "ChatGPT закрыт.";
    case "building":
      return "ChatGPT собирается на этом Mac. Первый раз это занимает до минуты.";
    case "unavailable":
      return "ChatGPT недоступен. " + (status.reason ?? "");
    case "open":
      if (status.proposal === "waiting") return "Текст ждёт подтверждения в ChatGPT.";
      if (status.proposal === "writing") return "Текст передаётся в поле ввода.";
      return "ChatGPT открыт.";
  }
}

const OUTCOME_TEXT = {
  "handed-off": "Последняя передача: текст передан в поле ввода. Проверьте черновик и отправьте сами.",
  unknown: "Последняя передача: результат неизвестен. Проверьте черновик перед повтором.",
  refused: "Последняя передача: вставка отменена, текст никуда не записан.",
  copied: "Последняя передача: текст скопирован, вставьте его сами.",
  cancelled: "Последняя передача отменена.",
} as const;

export function DockPage({ services, status, isUserAction = isTrustedEvent }: DockPageProps) {
  const { staging, window: chat, copyText, notify } = services;
  const staged = useStaged(staging);
  const [busy, setBusy] = useState(false);
  const sent = useRef<{ proposalId: string; text: string } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const hasText = staged !== null && staged.text.length > 0;
  const open = status?.window === "open";

  const attach = useCallback((view: Parameters<typeof chat.attach>[0]) => chat.attach(view), [chat]);
  useAttachment(area, attach, true);

  // Opening the ChatGPT page opens ChatGPT: no text is involved.
  useEffect(() => {
    chat.open().catch(() => notify("error", "Не удалось открыть ChatGPT."));
  }, [chat, notify]);

  // Once ChatGPT reports that the proposal may be in a draft, the same text
  // is dropped here so it cannot be handed over twice by mistake.
  useEffect(() => {
    const last = status?.last;
    const mine = sent.current;
    if (last === undefined || last === null || mine === null || last.proposalId !== mine.proposalId) return;
    if (last.outcome === "handed-off" || last.outcome === "unknown") staging.clearIf(mine.text);
    if (last.outcome !== "copied") sent.current = null;
  }, [status, staging]);

  async function reopen(event: MouseEvent) {
    if (!isUserAction(event) || busy) return;
    setBusy(true);
    try {
      const next = await chat.open();
      if (next.window === "unavailable") notify("error", next.reason ?? "ChatGPT недоступен.");
    } catch {
      notify("error", "Не удалось открыть ChatGPT.");
    } finally {
      setBusy(false);
    }
  }

  async function handOver(event: MouseEvent) {
    if (!isUserAction(event) || busy || staged === null || staged.text.length === 0) return;
    setBusy(true);
    const text = staged.text;
    try {
      const result = await chat.propose(text, staged.source.kind);
      if (result.ok) {
        sent.current = { proposalId: result.proposalId, text };
        notify("info", "Текст показан под ChatGPT. Проверьте беседу и подтвердите вставку там.");
      } else if (result.reason === "busy") {
        notify("error", "ChatGPT ещё принимает предыдущий текст. Дождитесь результата.");
      } else if (result.reason === "window-unavailable") {
        notify("error", "ChatGPT ещё не готов. Повторите, когда он откроется.");
      } else {
        notify("error", "Текст пуст или длиннее 100 000 знаков.");
      }
    } catch {
      notify("error", "Не удалось передать текст в ChatGPT.");
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
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div
        ref={area}
        data-chat-dock-area=""
        aria-label="ChatGPT"
        className="relative flex min-h-[24rem] min-w-0 flex-1 items-center justify-center border-b border-border lg:border-b-0 lg:border-r"
      >
        {/* Seen only while the ChatGPT window is not over this area. */}
        <div className="flex max-w-sm flex-col items-center gap-3 p-6 text-center">
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {describeStatus(status)}
          </p>
          {status !== null && !open && status.window !== "building" && (
            <button type="button" className={BUTTON_OUTLINE} disabled={busy} onClick={reopen}>
              Открыть ChatGPT
            </button>
          )}
        </div>
      </div>

      <aside aria-label="Подготовленный контекст" className="flex w-full flex-col gap-3 overflow-auto p-4 lg:w-[22rem] lg:shrink-0">
        <ContextPreview staging={staging} rows={10} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_PRIMARY} disabled={!hasText || busy || status?.proposal === "writing"} onClick={handOver}>
            Передать в ChatGPT
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
        {status?.last !== null && status?.last !== undefined && <p className="text-xs text-muted-foreground">{OUTCOME_TEXT[status.last.outcome]}</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">
          ChatGPT показан слева в собственном окне без адресной строки. Вход в нём сохраняется между запусками и отделён от
          Browser в BB; инструменты агентов BB (<code>bb browser</code>) до него не дотягиваются. Программы с полными правами в
          macOS, например средства автоматизации интерфейса, это окно видеть могут. Текст вставляется в черновик только
          после вашего нажатия «Вставить в черновик» под ChatGPT. Отправляете сообщение вы.
        </p>
      </aside>
    </div>
  );
}
