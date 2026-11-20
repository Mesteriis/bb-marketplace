import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { PersonalChannelChange, PersonalChannelSettings } from "../core/contract.ts";

export type PersonalChannelActions = {
  load: () => Promise<PersonalChannelSettings>;
  save: (change: PersonalChannelChange) => Promise<"saved" | "changed" | "unsupported">;
};

export function PersonalChannel({ actions }: { actions: PersonalChannelActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<PersonalChannelSettings>();
  const [choiceId, setChoiceId] = useState("");
  const [review, setReview] = useState<PersonalChannelChange>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<"saved" | "changed" | "unavailable" | "loadFailed">();

  useEffect(() => {
    if (!open) return;
    let current = true;
    setSettings(undefined);
    setChoiceId("");
    setReview(undefined);
    void actions.load().then((value) => { if (current) setSettings(value); },
      () => { if (current) setStatus("loadFailed"); });
    return () => { current = false; };
  }, [actions, open, revision]);

  async function confirm() {
    if (!review || busy) return;
    setBusy(true);
    const result = await actions.save(review).catch(() => "unsupported" as const);
    setBusy(false);
    setReview(undefined);
    setStatus(result === "unsupported" ? "unavailable" : result);
    setRevision((value) => value + 1);
  }

  const choices = settings?.choices.filter(({ id }) => id !== settings.selected) ?? [];
  const choice = choices.find(({ id }) => id === choiceId);
  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    setStatus(undefined);
    setReview(undefined);
  }}>
    <summary>{tr("Personal channel")}</summary>
    {open && <>
      {!settings && status !== "loadFailed" && <p role="status">{tr("Loading personal channel…")}</p>}
      {settings && <>
        <p>{settings.selected ? settings.current?.title ?? tr("Channel unavailable") : tr("Your profile has no personal channel.")}</p>
        {settings.current?.preview && <p>{settings.current.preview}</p>}
        {!!choices.length && <fieldset disabled={busy || !!review}>
          <legend>{tr("Show a channel on your Telegram profile")}</legend>
          <label>{tr("Channel ")}<select value={choiceId} onChange={(event) => setChoiceId(event.currentTarget.value)}>
            <option value="">{tr("Choose a channel")}</option>
            {choices.map(({ id, title }) => <option value={id} key={id}>{title}</option>)}
          </select></label>
          <button type="button" className="mtg-action" disabled={!choice} onClick={() => {
            if (choice) setReview({ expected: settings.selected, choice });
          }}>{tr("Review personal channel")}</button>
        </fieldset>}
        {settings.selected && <button type="button" className="mtg-action" disabled={busy || !!review}
          onClick={() => setReview({ expected: settings.selected, choice: null })}>{tr("Remove personal channel")}</button>}
      </>}
      {review && <div role="group" aria-label={tr("Confirm personal channel change")}>
        {review.choice ? <p>{tr("Show ")}<bdi>{review.choice.title}</bdi>{tr(" on your Telegram profile?")}</p>
          : <p>{tr("Remove your personal channel from your Telegram profile?")}</p>}
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{tr("Confirm personal channel change")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
      </div>}
      {status === "saved" && <p role="status">{tr("Personal channel saved.")}</p>}
      {status === "changed" && <p role="alert">{tr("Your personal channel changed in Telegram. Review the current choice.")}</p>}
      {status === "unavailable" && <p role="alert">{tr("Telegram could not change your personal channel.")}</p>}
      {status === "loadFailed" && <p role="alert">{tr("Could not load personal channels. ")}<button type="button" className="mtg-action"
        onClick={() => { setStatus(undefined); setRevision((value) => value + 1); }}>{tr("Retry")}</button></p>}
    </>}
  </details>;
}
