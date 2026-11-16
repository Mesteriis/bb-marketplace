import { SmilePlus } from "lucide-react";
import { useState } from "react";
import type { MessageReactions as Reactions } from "../core/contract.ts";

export type ReactionActions = {
  listReactions: (chatId: string, messageId: string) => Promise<string[]>;
  setReaction: (chatId: string, messageId: string, emoji: string, chosen: boolean) => Promise<boolean>;
};

export function MessageReactions({ chatId, messageId, reactions, actions }: {
  chatId: string;
  messageId: string;
  reactions?: Reactions;
  actions?: ReactionActions;
}) {
  const [choices, setChoices] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function open() {
    if (!actions || busy) return;
    if (choices) { setChoices(undefined); return; }
    setError(undefined);
    setBusy(true);
    try {
      setChoices(await actions.listReactions(chatId, messageId));
    } catch {
      setError("Could not load available reactions.");
    } finally {
      setBusy(false);
    }
  }

  async function choose(emoji: string, chosen: boolean) {
    if (!actions || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      if (await actions.setReaction(chatId, messageId, emoji, chosen)) setChoices(undefined);
      else setError("Telegram did not confirm the reaction.");
    } catch {
      setError("Telegram did not confirm the reaction.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    {reactions && <ul className="mtg-reactions" aria-label={reactions.tags ? "Message tags" : "Message reactions"}>
      {reactions.items.map(({ type, count, chosen }, index) => {
        const label = type.kind === "emoji" ? type.emoji : type.kind === "paid" ? "Stars" : "Custom emoji";
        return <li key={index} className={chosen ? "mtg-reaction-chosen" : undefined}>
          {actions && type.kind === "emoji"
            ? <button type="button" aria-pressed={chosen} aria-label={`React ${label}, ${count}`}
              disabled={busy} onClick={() => void choose(label, !chosen)}>{label} <span>{count}</span></button>
            : <>{label} <span>{count}</span>{chosen && <span className="mtg-visually-hidden"> · You reacted</span>}</>}
        </li>;
      })}
    </ul>}
    {actions && <button type="button" className="mtg-reply-action" aria-label="Add reaction" title="Add reaction"
      aria-expanded={choices !== undefined} disabled={busy} onClick={() => void open()}><SmilePlus size={15} aria-hidden="true" /></button>}
    {!!choices?.length && <div className="mtg-reaction-picker" role="group" aria-label="Available reactions">
      {choices.map((emoji) => {
        const chosen = reactions?.items.some((row) => row.chosen && row.type.kind === "emoji" && row.type.emoji === emoji) ?? false;
        return <button type="button" key={emoji} className="mtg-action" aria-label={`React ${emoji}`}
          aria-pressed={chosen} disabled={busy} onClick={() => void choose(emoji, !chosen)}>{emoji}</button>;
      })}
    </div>}
    {choices?.length === 0 && <span role="status">No available reactions.</span>}
    {error && <p role="alert">{error}</p>}
  </>;
}
