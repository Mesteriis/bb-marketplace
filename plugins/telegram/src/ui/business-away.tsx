import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { businessAway, type BusinessAway, type schemas } from "../core/contract.ts";
import { BusinessRecipientEditor, initialBusinessRecipients, type BusinessRecipientChat } from "./business-recipients.tsx";

type View = z.infer<typeof schemas.businessAway.output>;
type Change = z.input<typeof schemas.saveBusinessAway.input>;
type Shortcut = z.infer<typeof schemas.quickReplies.output>[number];

function localTime(timestamp?: number) {
  if (timestamp === undefined) return "";
  const date = new Date(timestamp * 1000);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 19);
}

function unixTime(value: string, original?: number) {
  const previous = localTime(original);
  if (original !== undefined && (value === previous || (value.length === 16 && previous === value + ":00"))) return original;
  const timestamp = Date.parse(value) / 1000;
  if (!Number.isFinite(timestamp)) return NaN;
  return localTime(timestamp).slice(0, value.length) === value ? timestamp : NaN;
}

export function BusinessAwaySettings({ read, save, loadShortcuts, findRecipients, knownChats }: {
  read: () => Promise<View>; save: (input: Change) => Promise<z.infer<typeof schemas.saveBusinessAway.output>>;
  loadShortcuts: () => Promise<Shortcut[]>; findRecipients: (query: string) => Promise<BusinessRecipientChat[]>;
  knownChats: readonly BusinessRecipientChat[];
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [view, setView] = useState<View>();
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [shortcutId, setShortcutId] = useState(0);
  const [schedule, setSchedule] = useState<BusinessAway["schedule"]["kind"]>("always");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [recipients, setRecipients] = useState(initialBusinessRecipients);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const savedSchedule = view?.away?.schedule;
  const savedPeriod = savedSchedule?.kind === "custom" ? savedSchedule : undefined;
  const nextSchedule = schedule === "custom"
    ? { kind: schedule, start: unixTime(start, savedPeriod?.start), end: unixTime(end, savedPeriod?.end) }
    : { kind: schedule };
  const away = enabled ? businessAway.safeParse({ shortcutId, schedule: nextSchedule, offlineOnly, recipients }).data : null;
  const changed = JSON.stringify(away) !== JSON.stringify(view?.away);
  const validShortcut = !enabled || shortcuts.some(({ id }) => id === shortcutId);
  const validAudience = !enabled || recipients.exclude || !!recipients.chats.length
    || recipients.existing || recipients.newChats || recipients.contacts || recipients.nonContacts;

  async function load() {
    const current = await read();
    const replies = current ? await loadShortcuts() : [];
    setView(current);
    setShortcuts(replies.filter(({ messageCount }) => messageCount > 0));
    const saved = current?.away;
    setEnabled(!!saved);
    setShortcutId(saved?.shortcutId ?? 0);
    setSchedule(saved?.schedule.kind ?? "always");
    setStart(localTime(saved?.schedule.kind === "custom" ? saved.schedule.start : undefined));
    setEnd(localTime(saved?.schedule.kind === "custom" ? saved.schedule.end : undefined));
    setOfflineOnly(saved?.offlineOnly ?? false);
    setRecipients(saved?.recipients ?? initialBusinessRecipients);
    setStale(false);
  }

  async function run(task: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await task(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!view || stale || away === undefined || !changed || !validShortcut || !validAudience) return;
    void run(async () => {
      const result = await save({ away, revision: view.revision });
      if (result === "saved") {
        setNotice(away ? "Away message saved." : "Away message disabled.");
        setStale(true);
        try { await load(); }
        catch { setError("Could not reload the away message. Reload before editing again."); }
      } else if (result === "changed") {
        setStale(true);
        setError("The away message changed in Telegram. Reload before editing.");
      } else setError("Telegram could not use this away message.");
    }, "Could not confirm the away message update.");
  }

  return <>
    <h3>{tr("Business away message")}</h3>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void run(load, "Could not load the away message.")}>
      {view === undefined ? tr("Load away message") : tr("Reload away message")}
    </button>
    {view === null && <p>{tr("The away message is unavailable for this account.")}</p>}
    {view && <form onSubmit={submit}>
      <fieldset disabled={busy || stale}>
        <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{tr("Enable away message")}</label>
        {enabled && <>
          <label>{tr("Away shortcut ")}<select value={shortcutId} onChange={(event) => setShortcutId(Number(event.target.value))}>
            <option value={0}>{tr("Choose a quick reply")}</option>
            {view.away?.shortcutId && !shortcuts.some(({ id }) => id === view.away?.shortcutId)
              && <option value={view.away.shortcutId}>{tr("Current shortcut unavailable")}</option>}
            {shortcuts.map(({ id, name }) => <option key={id} value={id}>/{name}</option>)}
          </select></label>
          <label>{tr("Away schedule ")}<select value={schedule} onChange={(event) => setSchedule(event.target.value as BusinessAway["schedule"]["kind"])}>
            <option value="always">{tr("Always")}</option>
            <option value="outside">{tr("Outside Business hours")}</option>
            <option value="custom">{tr("Custom period")}</option>
          </select></label>
          {schedule === "custom" && <>
            <label>{tr("Away starts ")}<input type="datetime-local" step="1" value={start} onChange={(event) => setStart(event.target.value)} /></label>
            <label>{tr("Away ends ")}<input type="datetime-local" step="1" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
            <p>{tr("Times use this device’s time zone.")}</p>
          </>}
          <label><input type="checkbox" checked={offlineOnly} onChange={(event) => setOfflineOnly(event.target.checked)} />{tr("Only send if offline for at least 10 minutes")}</label>
          <BusinessRecipientEditor label={tr("Away message recipients")} recipients={recipients} knownChats={knownChats}
            findRecipients={findRecipients} setRecipients={setRecipients} />
          <p>{tr("Telegram sends the selected quick reply automatically according to this schedule.")}</p>
        </>}
      </fieldset>
      <button type="submit" className="mtg-action" disabled={busy || stale || away === undefined || !changed
        || !validShortcut || !validAudience}>{tr("Save away message")}</button>
    </form>}
    {busy && <p role="status">{tr("Updating away message…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </>;
}
