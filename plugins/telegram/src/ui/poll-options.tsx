import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useState } from "react";
import { pollOptionText, type PollOptionChangeResult } from "../core/contract.ts";

export const PollOptionActions = createContext<{
  add: (chat: string, message: string, text: string) => Promise<PollOptionChangeResult>;
  canRemove: (chat: string, message: string, option: string, text: string) => Promise<boolean>;
  remove: (chat: string, message: string, option: string, text: string) => Promise<PollOptionChangeResult>;
} | undefined>(undefined);

export function AddPollOption({ add }: { add: (text: string) => Promise<PollOptionChangeResult> }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<PollOptionChangeResult | "working">();
  const value = pollOptionText.safeParse(text);
  if (!open) return <button type="button" className="mtg-action" onClick={() => setOpen(true)}>{tr("Suggest an answer")}</button>;

  return <form onSubmit={async (event) => {
    event.preventDefault();
    if (!value.success || status === "working") return;
    setStatus("working");
    const result = await add(value.data).catch(() => "unknown" as const);
    setStatus(result);
    if (result === "updated") {
      setText("");
      setOpen(false);
    }
  }}>
    <label>{tr("Suggested answer ")}<input autoFocus value={text} maxLength={100}
      disabled={status === "working"} onChange={(event) => setText(event.currentTarget.value)} /></label>
    <button type="submit" className="mtg-action" disabled={!value.success || status === "working"}>{tr("Add answer")}</button>
    <button type="button" className="mtg-action" disabled={status === "working"} onClick={() => {
      setOpen(false);
      setStatus(undefined);
    }}>{tr("Cancel")}</button>
    {status === "unavailable" && <p role="alert">{tr("This answer could not be added. Check the poll and its current answers.")}</p>}
    {status === "unknown" && <p role="alert">{tr("Telegram did not confirm the change. Check the poll before trying again.")}</p>}
  </form>;
}

export function RemovePollOption({ text, check, remove }: {
  text: string;
  check: () => Promise<boolean>;
  remove: () => Promise<PollOptionChangeResult>;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"checking" | "review" | "working" | PollOptionChangeResult>();
  if (status === "updated") return null;
  if (status === "review" || status === "working") return <div role="group" aria-label={tr("Review poll answer removal")}>
    <p>{tr("Remove ")}<bdi>{text}</bdi>{tr(" from this poll for everyone?")}</p>
    <button type="button" className="mtg-action" disabled={status === "working"} onClick={async () => {
      setStatus("working");
      setStatus(await remove().catch(() => "unknown" as const));
    }}>{tr("Confirm answer removal")}</button>
    <button type="button" className="mtg-action" disabled={status === "working"} onClick={() => setStatus(undefined)}>{tr("Cancel")}</button>
  </div>;
  return <>
    <button type="button" className="mtg-action" aria-label={tr("Remove answer: {0}", [text])} disabled={status === "checking"} onClick={async () => {
      setStatus("checking");
      setStatus(await check().catch(() => false) ? "review" : "unavailable");
    }}>{tr("Remove answer")}</button>
    {status === "unavailable" && <p role="status">{tr("This answer cannot be removed.")}</p>}
    {status === "unknown" && <p role="alert">{tr("Telegram did not confirm the change. Check the poll before trying again.")}</p>}
  </>;
}
