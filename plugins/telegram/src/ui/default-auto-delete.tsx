import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { autoDeleteDays, type ChatAutoDelete } from "../core/contract.ts";

export type AutoDeleteActions = {
  load: () => Promise<ChatAutoDelete | null>;
  save: (days: number, expected: number) => Promise<"saved" | "changed" | "unavailable">;
};

export function AutoDeleteTimer({ actions, chat = false }: { actions: AutoDeleteActions; chat?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const timer = chat ? "chat timer" : "default timer";
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ChatAutoDelete | null>();
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCurrent(undefined);
    setError("");
    void actions.load().then((setting) => {
      if (!active) return;
      setCurrent(setting);
      setDraft(String(setting?.days ?? ""));
    }, () => { if (active) setError(tr("Could not load the {0}.", [timer])); });
    return () => { active = false; };
  }, [actions, open, revision, timer]);

  const days = autoDeleteDays.safeParse(draft === "" ? NaN : Number(draft));
  const changed = current?.editable && days.success && days.data !== current.days;

  async function save() {
    if (!confirm || !days.success || !changed || !current || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await actions.save(days.data, current.days);
      if (result === "saved") {
        setCurrent({ ...current, days: days.data });
        setNotice(chat ? "Chat timer saved." : "Default timer saved.");
      } else {
        setCurrent(undefined);
        setError(result === "changed" ? tr("The {0} changed in Telegram.", [timer]) : "Telegram did not accept the timer.");
      }
    } catch {
      setCurrent(undefined);
      setError("Telegram did not confirm the change.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    setConfirm(false);
    setNotice("");
  }}>
    <summary>{chat ? tr("Auto-delete messages") : tr("Auto-delete in new chats")}</summary>
    {open && <>
      {current === undefined && !error && <p role="status">{tr("Loading ")}{timer}…</p>}
      {current === null && <p>{tr("Auto-delete is unavailable for this chat.")}</p>}
      {current && !current.editable && <p>{current.days ? tr("Auto-delete after {0} days.", [current.days]) : tr("Auto-delete is off.")}{tr(" Changing the timer requires permission in Telegram.")}</p>}
      {current?.editable && <form onSubmit={(event) => { event.preventDefault(); if (changed && !busy) setConfirm(true); }}>
        <p>{chat ? tr("Telegram applies this timer to new messages in this chat.") : tr("Telegram applies this timer to new chats.")}{tr(" Set it to 0 to turn it off.")}</p>
        <label>{tr("Auto-delete after (days) ")}<input type="number" min={0} max={365} step={1} required value={draft}
          disabled={busy || confirm} onChange={(event) => { setDraft(event.currentTarget.value); setNotice(""); }} /></label>
        {confirm ? <>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => void save()}>{tr("Confirm ")}{timer}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(false)}>{tr("Cancel")}</button>
        </> : <button type="submit" className="mtg-action" disabled={busy || !changed}>{tr("Save ")}{timer}</button>}
      </form>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload ")}{timer}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
