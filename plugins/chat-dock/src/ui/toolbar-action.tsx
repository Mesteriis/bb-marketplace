// The control beside the Browser's address bar. It appears only on
// chatgpt.com and only in the embedded mode. Opening it chooses the
// conversation the tab shows; the panel then shows the text and that
// conversation, and inserts, copies or cancels on the user's click.
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { describeTarget, isChatGptUrl } from "../core/target.ts";
import { createTransfer, describeRefusal, type PagePort, type TransferSession } from "../core/transfer.ts";
import { ContextPreview } from "./context-preview.tsx";
import {
  BUTTON_GHOST,
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  isTrustedEvent,
  type DockServices,
  type IsUserAction,
} from "./services.ts";
import { useConsent, useStaged, useTransferState } from "./use-store.ts";

interface ToolbarActionProps {
  services: DockServices;
  /** The tab's top-level address, as the host reports it. */
  url: string;
  /** Script access to the tab's document; null outside the desktop app. */
  page: PagePort | null;
  newNonce(): string;
  /** Attributes the host expects on an overlay drawn above the Browser. */
  overlayProps?: Record<string, string>;
  isUserAction?: IsUserAction;
}

export function ToolbarAction({
  services,
  url,
  page,
  newNonce,
  overlayProps = {},
  isUserAction = isTrustedEvent,
}: ToolbarActionProps) {
  const { staging, consent, copyText, notify } = services;
  const embedded = useConsent(consent);
  const staged = useStaged(staging);
  const [session, setSession] = useState<TransferSession | null>(null);
  const state = useTransferState(session);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  const sessionRef = useRef<TransferSession | null>(null);
  sessionRef.current = session;

  const clipboard = useMemo(() => ({ writeText: copyText }), [copyText]);
  const onChatGpt = isChatGptUrl(url);
  const visible = embedded && onChatGpt;

  // The host reports a new address: a chosen conversation that no longer
  // matches is withdrawn at once.
  useEffect(() => {
    session?.hostUrlChanged(url);
  }, [session, url]);

  // Leaving ChatGPT, turning the mode off or losing the tab ends the session.
  useEffect(() => {
    if (!visible && session !== null) setSession(null);
  }, [visible, session]);

  useEffect(() => {
    if (session === null) return;
    return () => session.dispose();
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSession(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [session]);

  if (!visible) return null;

  function close() {
    setSession(null);
    triggerRef.current?.focus();
  }

  function toggle(event: MouseEvent) {
    if (!isUserAction(event)) return;
    if (session !== null) return close();
    const next = createTransfer({ page, clipboard, newNonce });
    setSession(next);
    void next.bind(urlRef.current);
  }

  function rebind(event: MouseEvent) {
    if (!isUserAction(event) || session === null) return;
    void session.bind(urlRef.current);
  }

  async function insert(event: MouseEvent) {
    if (!isUserAction(event) || session === null || staged === null) return;
    const used = session;
    const outcome = await used.confirm(staged.text);
    // The staged text is dropped once it may be in a draft, so it cannot be
    // inserted a second time by reopening the panel.
    if (outcome === "handed-off" || outcome === "unknown") staging.clear();
    if (sessionRef.current === used) return;
    // The panel was closed while the page was answering: say what happened.
    if (outcome === "handed-off") notify("info", "Текст передан в поле ввода ChatGPT. Проверьте черновик.");
    if (outcome === "unknown") {
      notify("error", "Результат вставки неизвестен: страница не ответила. Проверьте черновик перед повтором.");
    }
  }

  async function copy(event: MouseEvent) {
    if (!isUserAction(event) || session === null || staged === null) return;
    const ok = await session.copy(staged.text);
    notify(ok ? "success" : "error", ok ? "Контекст скопирован. Вставьте его в поле ChatGPT сами: ⌘V." : "Не удалось записать буфер обмена.");
  }

  const hasText = staged !== null && staged.text.length > 0;
  const busy = state.kind === "binding" || state.kind === "writing";
  const finished = state.kind === "handed-off" || state.kind === "unknown";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={BUTTON_GHOST}
        aria-haspopup="dialog"
        aria-expanded={session !== null}
        onClick={toggle}
      >
        Вставить в ChatGPT…
      </button>
      {session !== null &&
        createPortal(
          <div
            {...overlayProps}
            ref={panelRef}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="fixed right-3 top-24 z-50 flex max-h-[80vh] w-[28rem] max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg focus-visible:outline-none"
          >
            <h2 id={titleId} className="text-sm font-semibold">
              Вставить в ChatGPT
            </h2>

            <p role="status" aria-live="polite" className="text-xs leading-relaxed">
              {state.kind === "binding" && "Проверяю беседу во вкладке…"}
              {state.kind === "ready" && (
                <>
                  Адресат: <span className="font-medium">{describeTarget(state.target)}</span> на chatgpt.com. Текст
                  будет добавлен в конец её черновика. Отправка остаётся за вами.
                </>
              )}
              {state.kind === "writing" && "Передаю текст в поле ввода…"}
              {state.kind === "handed-off" && (
                <>
                  Текст передан в поле ввода: {describeTarget(state.target)}. Проверьте черновик и отправьте сообщение
                  сами.
                </>
              )}
              {state.kind === "unknown" && (
                <>
                  Результат неизвестен: страница не ответила. Проверьте черновик ({describeTarget(state.target)}) перед
                  любым повтором. Плагин не повторяет вставку сам.
                </>
              )}
              {state.kind === "unbound" &&
                (state.refusal === null
                  ? "Беседа не выбрана."
                  : "Автовставка недоступна. " + describeRefusal(state.refusal) + " Можно скопировать текст и вставить его вручную.")}
            </p>

            {!finished && <ContextPreview staging={staging} disabled={busy} />}

            <div className="flex flex-wrap items-center gap-2">
              {state.kind === "ready" && (
                <button type="button" className={BUTTON_PRIMARY} disabled={!hasText} onClick={insert}>
                  Вставить в черновик
                </button>
              )}
              {state.kind === "unbound" && (
                <button type="button" className={BUTTON_OUTLINE} onClick={rebind}>
                  Выбрать открытую беседу
                </button>
              )}
              {!finished && (
                <button type="button" className={BUTTON_OUTLINE} disabled={!hasText || busy} onClick={copy}>
                  Скопировать контекст
                </button>
              )}
              <button
                type="button"
                className={BUTTON_GHOST}
                onClick={(event) => {
                  if (isUserAction(event)) close();
                }}
              >
                {finished ? "Закрыть" : "Отмена"}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
