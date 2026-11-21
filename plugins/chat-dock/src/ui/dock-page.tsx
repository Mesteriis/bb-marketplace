// The ChatGPT page of the navigation: what the plugin does, the mode it is
// in, the staged text, and the explicit copy. It shows no imitation of a
// chat: the real site lives in BB's Browser, or wherever the user keeps it.
import { useState, type MouseEvent } from "react";
import { ContextPreview } from "./context-preview.tsx";
import {
  BUTTON_GHOST,
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  isTrustedEvent,
  type DockServices,
  type IsUserAction,
} from "./services.ts";
import { useConsent, useStaged } from "./use-store.ts";

interface DockPageProps {
  services: DockServices;
  /** Ask BB to open the site. False when BB declined. */
  openChatGpt(): boolean;
  isUserAction?: IsUserAction;
}

export function DockPage({ services, openChatGpt, isUserAction = isTrustedEvent }: DockPageProps) {
  const { staging, consent, copyText, notify } = services;
  const staged = useStaged(staging);
  const embedded = useConsent(consent);
  const [copying, setCopying] = useState(false);
  const hasText = staged !== null && staged.text.length > 0;

  async function copy(event: MouseEvent) {
    if (!isUserAction(event) || copying || staged === null || staged.text.length === 0) return;
    setCopying(true);
    try {
      const ok = await copyText(staged.text);
      notify(ok ? "success" : "error", ok ? "Контекст скопирован. Вставьте его в поле ChatGPT сами: ⌘V." : "Не удалось записать буфер обмена.");
    } finally {
      setCopying(false);
    }
  }

  function toggleEmbedded(event: MouseEvent) {
    if (!isUserAction(event)) return;
    if (embedded) consent.withdraw();
    else consent.grant();
  }

  function open(event: MouseEvent) {
    if (!isUserAction(event)) return;
    if (!openChatGpt()) notify("error", "BB не смог открыть chatgpt.com.");
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <section aria-labelledby="chat-dock-mode" className="rounded-md border border-border p-3">
          <h2 id="chat-dock-mode" className="text-sm font-semibold">
            Режим: {embedded ? "встроенный ChatGPT" : "ручная вставка"}
          </h2>
          {embedded ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Откройте беседу на chatgpt.com во вкладке Browser. Кнопка «Вставить в ChatGPT…» рядом с адресной строкой
              покажет текст и беседу и добавит текст в её черновик. Сообщение отправляете вы.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Подготовьте текст ниже, нажмите «Скопировать контекст» и вставьте его в ChatGPT сами.
            </p>
          )}
          <div role="note" className="mt-3 rounded-md border border-border bg-secondary p-2.5 text-xs leading-relaxed">
            <p className="font-medium">Почему встроенный режим выключен по умолчанию</p>
            <p className="mt-1">
              У встроенного Browser один общий вход для всех вкладок. Штатные инструменты агентов BB могут открыть
              вкладку с этим входом, управлять ею и снимать с неё изображение. Если вы войдёте в ChatGPT внутри BB,
              агенты на этом компьютере технически смогут читать вашу переписку. Плагин не может это отключить.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_OUTLINE} aria-pressed={embedded} onClick={toggleEmbedded}>
              {embedded ? "Выключить встроенный режим" : "Я понимаю риск: включить встроенный режим"}
            </button>
            {embedded && (
              <button type="button" className={BUTTON_GHOST} onClick={open}>
                Открыть chatgpt.com в BB
              </button>
            )}
          </div>
        </section>

        <section aria-label="Подготовленный контекст" className="flex flex-col gap-3">
          <ContextPreview staging={staging} rows={12} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_PRIMARY} disabled={!hasText || copying} onClick={copy}>
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
            Текст хранится только в памяти этого окна до передачи или очистки. В буфер обмена он попадает только по
            кнопке.
          </p>
        </section>
      </div>
    </div>
  );
}
