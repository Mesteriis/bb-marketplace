import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type ComponentProps } from "react";
import type { BotStartResult, ForwardTarget, LinkedGame } from "../core/contract.ts";
import { TelegramChatPickerDialog } from "./mini-app.tsx";

type ChatPicker = ComponentProps<typeof TelegramChatPickerDialog>;
export type GameLinkActions = {
  resolve: (url: string) => Promise<LinkedGame | null>;
  find: ChatPicker["find"];
  topics: NonNullable<ChatPicker["findTopics"]>;
  send: (url: string, bot: string, target: ForwardTarget) => Promise<BotStartResult>;
};

export function GameLinkCard({ url, game, actions, refresh }: {
  url: string; game: LinkedGame; actions: GameLinkActions; refresh: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [picker, setPicker] = useState(false);
  const [target, setTarget] = useState<ForwardTarget>();
  const [result, setResult] = useState<BotStartResult>();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function send() {
    if (!target || result || sending.current) return;
    sending.current = true;
    setBusy(true);
    const outcome = await actions.send(url, game.chat.id, target).catch(() => "unknown" as const);
    setResult(outcome);
    setBusy(false);
    if (outcome === "sent") refresh();
  }

  const notice = result === "sent" ? "Game sent." : result === "changed" ? "The bot or destination changed. Open the game link again."
    : result === "failed" ? "Telegram could not send this game."
    : result === "unknown" ? "Telegram did not confirm delivery. Check the destination before retrying." : undefined;
  return <li className="mtg-empty">
    <p><strong><bdi>{game.shortName}</bdi></strong> · <bdi>@{game.username}</bdi></p>
    {!result && <>
      {target && <p>{tr("Send to ")}<bdi>{target.name}</bdi>{target.topic && <> · <bdi>{target.topic.name}</bdi></>}</p>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setPicker(true)}>
        {target ? tr("Change game destination") : tr("Choose a chat for the game")}
      </button>
      {target && <button type="button" className="mtg-action" disabled={busy} onClick={() => void send()}>{busy ? tr("Sending game…") : tr("Send game")}</button>}
    </>}
    {notice && <p role={result === "sent" ? "status" : "alert"}>{tr(notice)}</p>}
    {picker && <TelegramChatPickerDialog title={tr("Choose a chat for the game")} unavailableText={tr("This chat cannot receive the game.")}
      close={() => setPicker(false)} find={actions.find} findTopics={(chat, query, cursor) => actions.topics(chat, query, cursor)}
      prepare={async (chat, signal, topic) => {
        if (signal.aborted || (chat.subtitle !== "Direct message" && chat.subtitle !== "Group")) return false;
        setTarget({ id: chat.id, name: chat.name, kind: chat.subtitle, ...(topic && { topic }) });
        return true;
      }} />}
  </li>;
}
