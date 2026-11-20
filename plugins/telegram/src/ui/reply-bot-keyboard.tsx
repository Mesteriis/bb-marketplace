import { useTelegramLocale } from "./i18n/index.tsx";
import { useMiniAppLauncher, type CloseMiniAppSession, type SendMiniAppData } from "./mini-app.tsx";
import { useEffect, useRef, useState } from "react";
import type { ReplyBotKeyboard as Keyboard, ReplyBotResult } from "../core/contract.ts";
import { DecorativeCustomEmoji } from "./custom-emoji.tsx";

export type ReplyBotActions = {
  miniApp?: {
    launch(id: string, messageId: string, revision: string, row: number, column: number): Promise<{ url: string; session: string } | null>;
    close: CloseMiniAppSession;
    send: SendMiniAppData;
  };
  load(id: string, topicId?: number): Promise<Keyboard | null>;
  press(id: string, topicId: number | undefined, messageId: string, revision: string, row: number, column: number): Promise<ReplyBotResult>;
};

export function ReplyBotKeyboard({ chatId, topicId, liveRevision, actions, disabled }: {
  chatId: string;
  topicId?: number;
  liveRevision?: number;
  actions: ReplyBotActions;
  disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const miniApp = useMiniAppLauncher();
  const miniAppActions = actions.miniApp;
  const [keyboard, setKeyboard] = useState<Keyboard | null>(null);
  const [used, setUsed] = useState<string>();
  const [status, setStatus] = useState<ReplyBotResult>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    void actions.load(chatId, topicId).then((value) => {
      if (current) setKeyboard(value);
    }, () => { if (current) setKeyboard(null); });
    return () => { current = false; };
  }, [actions, chatId, topicId, liveRevision, revision]);

  async function press(row: number, column: number) {
    if (!keyboard || disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(undefined);
    const result = await actions.press(chatId, topicId, keyboard.messageId, keyboard.revision, row, column)
      .catch(() => "unknown" as const);
    if (result === "sent" && keyboard.oneTime) setUsed(keyboard.messageId);
    if (result === "changed") setRevision((value) => value + 1);
    setStatus(result);
    setBusy(false);
    inFlight.current = false;
  }

  if ((!keyboard || keyboard.messageId === used) && (!status || status === "sent")) return null;
  return <div className="mtg-composer-media" role="group" aria-label={tr("Bot reply keyboard")} aria-busy={busy}>
    {keyboard && keyboard.messageId !== used && keyboard.rows.map((row) => <div key={row[0]?.row} className="mtg-inline-bot-row">
      {row.map(({ text, row, column, webApp, style, iconCustomEmojiId }) => <button type="button" className="mtg-action" key={column}
        data-button-style={style}
        disabled={disabled || busy || (webApp && (!actions.miniApp || topicId !== undefined))}
        aria-haspopup={webApp ? "dialog" : undefined}
        onClick={() => {
          if (!webApp) return void press(row, column);
          if (miniAppActions) miniApp.open({ target: { label: text },
            launch: () => miniAppActions.launch(chatId, keyboard.messageId, keyboard.revision, row, column),
            closeSession: miniAppActions.close, sendData: async (session, data) => {
              const result = await miniAppActions.send(session, data);
              if (result === "sent" && keyboard.oneTime) setUsed(keyboard.messageId);
              return result;
            } });
        }}><DecorativeCustomEmoji id={iconCustomEmojiId} className="mtg-bot-button-icon" />{text}</button>)}
    </div>)}
    {miniApp.dialog}
    {status && status !== "sent" && <p role="status">{status === "changed" ? tr("The bot keyboard changed.")
      : status === "failed" ? tr("Telegram could not send the bot reply.") : tr("Telegram did not confirm the bot reply.")}</p>}
  </div>;
}
