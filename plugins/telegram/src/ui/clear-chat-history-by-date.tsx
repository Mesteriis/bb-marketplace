import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { ClearChatDateRange, ClearChatDateResult, ClearChatDateScope } from "../core/contract.ts";
import { clearHistoryDays, localDateInputValue } from "../core/message-timeline.ts";

export type ClearChatHistoryByDateActions = {
  load: (id: string) => Promise<ClearChatDateScope[]>;
  clear: (id: string, range: ClearChatDateRange, scope: ClearChatDateScope) => Promise<ClearChatDateResult>;
};

type ClearHistoryProps = { name: string; disabled?: boolean } & (
  { id: string; actions: ClearChatHistoryByDateActions; clearInbox?: never }
  | { clearInbox: (range: ClearChatDateRange) => Promise<ClearChatDateResult> }
);

export function ClearChatHistoryByDate(props: ClearHistoryProps) {
  const { t: tr } = useTelegramLocale();
  const { name, clearInbox } = props;
  const [scopes, setScopes] = useState<ClearChatDateScope[]>();
  const [scope, setScope] = useState<ClearChatDateScope | "">("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [review, setReview] = useState<{ start: string; end: string; range: ClearChatDateRange; scope: ClearChatDateScope }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const range = clearHistoryDays(start, end);
  const now = Math.floor(Date.now() / 1000);
  const today = localDateInputValue(now);

  async function open() {
    setNotice("");
    if (clearInbox) {
      setScopes(["everyone"]);
      setScope("everyone");
      return;
    }
    setBusy(true);
    try {
      const available = await props.actions.load(props.id);
      setScopes(available);
      setScope("");
      if (!available.length) setNotice("Telegram does not allow clearing history by date in this chat.");
    } catch {
      setNotice("Could not check the options in Telegram.");
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!review || busy || props.disabled) return;
    setBusy(true);
    const operation = clearInbox
      ? clearInbox(review.range)
      : props.actions.clear(props.id, review.range, review.scope);
    const outcome = await operation.catch(() => "unknown" as const);
    setReview(undefined);
    setScopes(undefined);
    setNotice({
      deleted: "Telegram confirmed clearing history for the selected dates.",
      refused: "Could not clear history for the selected dates.",
      unknown: "Telegram did not confirm the result. Check the chat before trying again.",
      localUnconfirmed: "Telegram cleared the history. BB could not confirm cleanup of the local copies.",
    }[outcome]);
    setBusy(false);
  }

  return <section>
    {!scopes?.length ? <button type="button" className="mtg-action" disabled={busy || props.disabled}
      onClick={() => void open()}>{tr("Clear history by date")}</button> : <fieldset aria-label={tr("Clear history by date")} disabled={busy || props.disabled}>
      <legend>{tr("Clear history by date")}</legend>
      {review ? <div role="group" aria-label={tr("Review history deletion")}>
        <p>{clearInbox ? tr("Clear messages in the channel conversation with ") :
          review.scope === "everyone" ? tr("Clear messages for both participants in ") : tr("Clear messages for you in ")}<bdi>{name}</bdi>
          {review.start === review.end ? tr(" on {0}", [review.start]) : tr(" from {0} through {1}", [review.start, review.end])}?</p>
        <p>{tr("Dates use your local time. Messages from the last 30 seconds may remain.")}</p>
        <button type="button" className="mtg-action" autoFocus onClick={() => setReview(undefined)}>{tr("Back")}</button>
        <button type="button" className="mtg-action" onClick={() => void confirm()}>{tr("Confirm clearing history")}</button>
      </div> : <>
        <label>{tr("From ")}<input type="date" value={start} max={today} onChange={(event) => setStart(event.currentTarget.value)} /></label>
        <label>{tr("Through ")}<input type="date" value={end} min={start || undefined} max={today} onChange={(event) => setEnd(event.currentTarget.value)} /></label>
        {!clearInbox && <label>{tr("Delete for ")}<select value={scope} onChange={(event) => {
          const value = event.currentTarget.value;
          setScope(scopes.find((option) => option === value) ?? "");
        }}>
          <option value="">{tr("Choose who")}</option>
          {scopes.map((option) => <option key={option} value={option}>{option === "everyone" ? tr("Both participants") : tr("Only me")}</option>)}
        </select></label>}
        <button type="button" className="mtg-action" disabled={!range || !scope || range.start >= now - 30 || end > today}
          onClick={() => { if (range && scope) setReview({ start, end, range, scope }); }}>{tr("Review dates")}</button>
        <button type="button" className="mtg-action" onClick={() => setScopes(undefined)}>{tr("Cancel")}</button>
      </>}
    </fieldset>}
    {notice && <p role="status">{tr(notice)}</p>}
  </section>;
}
