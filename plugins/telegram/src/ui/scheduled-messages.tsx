import { useEffect, useState, type ComponentProps } from "react";
import { scheduleRepeatPeriods, type ScheduledMessage, type ScheduleRepeatPeriod, type SendResult, type TextDelivery } from "../core/contract.ts";

import { MessageContent } from "./message-content.tsx";

type ScheduledMedia = Pick<ComponentProps<typeof MessageContent>, "loadPhoto" | "loadMedia" | "loadVideoStream">;

function repeatLabel(seconds: number): string {
  if (seconds === 86400) return "Every day";
  if (seconds === 604800) return "Every week";
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} days`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} min`;
  return `Every ${seconds} sec`;
}

function localScheduleTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function ScheduledMessages({ chatId, topicId, draft, canSend, send, load, checkOnline, checkRepeat, cancel, change, accepted, liveRevision, mediaLoaders }: {
  chatId: string;
  topicId?: number;
  mediaLoaders?: ScheduledMedia;
  liveRevision: number;
  draft: string;
  canSend: boolean;
  send: (delivery: TextDelivery) => Promise<SendResult>;
  load: (id: string, topicId?: number) => Promise<ScheduledMessage[]>;
  checkRepeat?: () => Promise<boolean>;
  checkOnline?: (id: string) => Promise<boolean>;
  cancel: (id: string, messageId: string, topicId?: number) => Promise<boolean>;
  change?: (id: string, row: ScheduledMessage, at: number | null, topicId?: number) => Promise<"updated" | "changed" | "unavailable">;
  accepted: (text: string, result: Extract<SendResult, { state: "sent" }>, scheduled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [onlineAllowed, setOnlineAllowed] = useState(false);
  const [repeatAllowed, setRepeatAllowed] = useState(false);
  const [repeatEvery, setRepeatEvery] = useState<ScheduleRepeatPeriod>();
  const [silent, setSilent] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<ScheduledMessage[]>();
  const [loadError, setLoadError] = useState(false);
  const [editTime, setEditTime] = useState<{ id: string; value: string }>();
  const [openPreview, setOpenPreview] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let current = true;
    void (topicId === undefined ? load(chatId) : load(chatId, topicId)).then(
      (result) => { if (current) { setRows(result); setLoadError(false); } },
      () => { if (current) setLoadError(true); },
    );
    return () => { current = false; };
  }, [open, chatId, topicId, revision, load, liveRevision]);

  useEffect(() => {
    setOnlineAllowed(false);
    if (!open || !checkOnline) return;
    let active = true;
    void checkOnline(chatId).then((allowed) => {
      if (active) setOnlineAllowed(allowed);
    }, () => { if (active) setOnlineAllowed(false); });
    return () => { active = false; };
  }, [open, chatId, checkOnline, liveRevision]);

  useEffect(() => {
    if (!open || !checkRepeat) return;
    let active = true;
    void checkRepeat().then((allowed) => {
      if (active) setRepeatAllowed(allowed);
    }, () => { if (active) setRepeatAllowed(false); });
    return () => { active = false; };
  }, [open, checkRepeat]);

  async function submit(mode: "silent" | "date" | "online") {
    const schedule = mode !== "silent";
    const text = draft.trim();
    if (busy || !canSend || !text || mode === "online" && !onlineAllowed) return;
    const at = mode === "date" ? Math.floor(new Date(when).getTime() / 1000) : undefined;
    if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10)) {
      setStatus("Choose a date and time in the future.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await send({ silent: schedule ? silent : true, ...(at === undefined ? {} : { at }),
        ...(mode === "online" ? { whenOnline: true } : {}),
        ...(mode === "date" && repeatAllowed && repeatEvery ? { repeatEvery } : {}) });
      if (result.state !== "sent") {
        setStatus(result.state === "failed" ? "Telegram rejected the message. Your draft is still here."
          : "Delivery unconfirmed. Check the chat and scheduled messages before retrying.");
        return;
      }
      accepted(text, result, schedule);
      if (schedule) {
        setWhen("");
        setRepeatEvery(undefined);
        setRevision((value) => value + 1);
      }
      setStatus(schedule ? "Scheduled." : "Sent silently.");
    } catch {
      setStatus("Delivery unconfirmed. Check Telegram before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function updateSchedule(row: ScheduledMessage, at: number | null) {
    if (!change || busy) return;
    if (at !== null && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) {
      setStatus("Choose a supported date and time in the future.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await (topicId === undefined ? change(chatId, row, at) : change(chatId, row, at, topicId));
      if (result === "updated") {
        setRows((previous) => at === null ? previous?.filter(({ id }) => id !== row.id)
          : previous?.map((item) => {
            if (item.id !== row.id) return item;
            const { whenOnline: _whenOnline, ...eligible } = item;
            return { ...eligible, at };
          }));
        setEditTime(undefined);
        setStatus(at === null ? "Telegram released the message for sending." : "Schedule updated.");
      } else {
        if (result === "changed") setEditTime(undefined);
        setStatus(result === "changed" ? "The scheduled message changed in Telegram." : "Telegram could not update the schedule.");
      }
    } catch {
      setStatus("Telegram did not confirm the change. Check the schedule before retrying.");
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      if (await (topicId === undefined ? cancel(chatId, id) : cancel(chatId, id, topicId))) {
        setRows((previous) => previous?.filter((row) => row.id !== id));
        setStatus("Scheduled message cancelled.");
      } else setStatus("This message could not be cancelled.");
    } catch {
      setStatus("Could not confirm cancellation.");
    } finally {
      setConfirm(undefined);
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  return <div className="mtg-composer-media">
    <div><button type="button" className="mtg-action" aria-expanded={open} disabled={busy} onClick={() => {
      setOpen(!open);
      setOpenPreview(undefined);
      setConfirm(undefined);
      setEditTime(undefined);
    }}>Send options</button></div>
    {open && <>
      <div className="mtg-composer-media-buttons">
        <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim()} onClick={() => void submit("silent")}>Send silently</button>
        {onlineAllowed && <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim()}
          onClick={() => void submit("online")}>Send when online</button>}
        <label>Send at <input type="datetime-local" value={when} disabled={busy} onInput={(event) => setWhen(event.currentTarget.value)} /></label>
        {repeatAllowed && <label>Repeat <select value={repeatEvery ?? ""} disabled={busy}
          onChange={(event) => setRepeatEvery(scheduleRepeatPeriods.find((seconds) => seconds === Number(event.target.value)))}>
          <option value="">Never</option>
          {scheduleRepeatPeriods.map((seconds) => <option key={seconds} value={seconds}>{repeatLabel(seconds)}</option>)}
        </select></label>}
        <label><input type="checkbox" checked={silent} disabled={busy} onChange={(event) => setSilent(event.target.checked)} /> Silent</label>
        <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim() || !when} onClick={() => void submit("date")}>Schedule message</button>
      </div>
      {loadError ? <p role="alert">Could not load scheduled messages. <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>Retry</button></p>
        : rows?.length ? <ul className="mtg-scheduled-list" aria-label="Scheduled messages">{rows.map((row) => <li key={row.id}>
          <span>{row.whenOnline ? "When online" : row.at === undefined ? "Scheduled" : new Date(row.at * 1000).toLocaleString()}</span>
          {row.repeatEvery && <p>{repeatLabel(row.repeatEvery)}</p>}
          {row.media && mediaLoaders ? <>
            <button type="button" className="mtg-action" aria-expanded={openPreview === row.id}
              onClick={() => setOpenPreview(openPreview === row.id ? undefined : row.id)}>
              {openPreview === row.id ? "Hide media preview" : "Preview scheduled media"}
            </button>
            {openPreview === row.id ? <MessageContent key={row.id} chatId={chatId} message={row.media} {...mediaLoaders} />
              : <p>{row.text}</p>}
          </> : <p>{row.text}</p>}
          {confirm === row.id ? <>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => void remove(row.id)}>Confirm cancellation</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>Keep message</button>
          </> : editTime?.id === row.id ? <>
            <label>New send time <input type="datetime-local" value={editTime.value} disabled={busy}
              onInput={(event) => setEditTime({ id: row.id, value: event.currentTarget.value })} /></label>
            <button type="button" className="mtg-action" disabled={busy || !editTime.value}
              onClick={() => void updateSchedule(row, Math.floor(new Date(editTime.value).getTime() / 1000))}>Save new send time</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setEditTime(undefined)}>Keep current time</button>
          </> : <>
            {change && <button type="button" className="mtg-action" disabled={busy}
              title="Telegram also sends messages scheduled together with this one" onClick={() => void updateSchedule(row, null)}>Send now</button>}
            {change && (row.at !== undefined || row.whenOnline) && <button type="button" className="mtg-action" disabled={busy}
              title="Telegram also reschedules messages scheduled together with this one" onClick={() => {
                setConfirm(undefined);
                setEditTime({ id: row.id, value: row.at === undefined ? "" : localScheduleTime(row.at) });
              }}>Reschedule</button>}
            <button type="button" className="mtg-action" disabled={busy} onClick={() => {
              setEditTime(undefined);
              setConfirm(row.id);
            }}>Cancel scheduled message</button>
          </>}
        </li>)}</ul> : <p>{rows ? "No scheduled messages." : "Loading scheduled messages…"}</p>}
      {status && <p role="status">{status}</p>}
    </>}
  </div>;
}
