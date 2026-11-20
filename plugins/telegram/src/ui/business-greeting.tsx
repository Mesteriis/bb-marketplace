import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { BusinessRecipientEditor, initialBusinessRecipients, type BusinessRecipientChat } from "./business-recipients.tsx";
import { businessGreeting, type BusinessGreeting, type schemas } from "../core/contract.ts";

type View = z.infer<typeof schemas.businessGreeting.output>;
type Change = z.input<typeof schemas.saveBusinessGreeting.input>;
type Shortcut = z.infer<typeof schemas.quickReplies.output>[number];

export function BusinessGreetingSettings({ read, save, loadShortcuts, findRecipients, knownChats }: {
  read: () => Promise<View>;
  save: (input: Change) => Promise<z.infer<typeof schemas.saveBusinessGreeting.output>>;
  loadShortcuts: () => Promise<Shortcut[]>;
  findRecipients: (query: string) => Promise<BusinessRecipientChat[]>;
  knownChats: readonly BusinessRecipientChat[];
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [view, setView] = useState<View>();
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [shortcutId, setShortcutId] = useState(0);
  const [inactivity, setInactivity] = useState<BusinessGreeting["inactivity"]>(7);
  const [recipients, setRecipients] = useState(initialBusinessRecipients);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const greeting = enabled ? businessGreeting.safeParse({ shortcutId, inactivity, recipients }).data : null;
  const changed = JSON.stringify(greeting) !== JSON.stringify(view?.greeting);
  const validShortcut = !enabled || shortcuts.some(({ id }) => id === shortcutId);
  const validAudience = !enabled || recipients.exclude || !!recipients.chats.length
    || recipients.existing || recipients.newChats || recipients.contacts || recipients.nonContacts;

  async function load() {
    const current = await read();
    const replies = current ? await loadShortcuts() : [];
    setView(current);
    setShortcuts(replies.filter(({ messageCount }) => messageCount > 0));
    setEnabled(!!current?.greeting);
    setShortcutId(current?.greeting?.shortcutId ?? 0);
    setInactivity(current?.greeting?.inactivity ?? 7);
    setRecipients(current?.greeting?.recipients ?? initialBusinessRecipients);
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
    if (!view || stale || greeting === undefined || !changed || !validShortcut || !validAudience) return;
    void run(async () => {
      const result = await save({ greeting, revision: view.revision });
      if (result === "saved") {
        setNotice(greeting ? "Business greeting saved." : "Business greeting disabled.");
        setStale(true);
        try { await load(); }
        catch { setError("Could not reload the greeting. Reload before editing again."); }
      } else if (result === "changed") {
        setStale(true);
        setError("The greeting changed in Telegram. Reload before editing.");
      } else setError("Telegram could not use this greeting or its recipients.");
    }, "Could not confirm the Business greeting update.");
  }

  return <>
    <h3>{tr("Business greeting")}</h3>
    <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void run(load, "Could not load the Business greeting.")}>{view === undefined ? tr("Load greeting") : tr("Reload greeting")}</button>
    {view === null && <p>{tr("The Business greeting is unavailable for this account.")}</p>}
    {view && <form onSubmit={submit}>
      <fieldset disabled={busy || stale}>
        <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{tr("Enable automatic greeting")}</label>
        {enabled && <>
          <label>{tr("Greeting shortcut ")}<select value={shortcutId} onChange={(event) => setShortcutId(Number(event.target.value))}>
            <option value={0}>{tr("Choose a quick reply")}</option>
            {view.greeting?.shortcutId && !shortcuts.some(({ id }) => id === view.greeting?.shortcutId)
              && <option value={view.greeting.shortcutId}>{tr("Current shortcut unavailable")}</option>}
            {shortcuts.map(({ id, name }) => <option key={id} value={id}>/{name}</option>)}
          </select></label>
          <label>{tr("Send again after inactivity ")}<select value={inactivity}
            onChange={(event) => setInactivity(Number(event.target.value) as BusinessGreeting["inactivity"])}>
            {([7, 14, 21, 28] as const).map((days) => <option key={days} value={days}>{days}{tr(" days")}</option>)}
          </select></label>
          <BusinessRecipientEditor label={tr("Greeting recipients")} recipients={recipients} knownChats={knownChats}
            findRecipients={findRecipients} setRecipients={setRecipients} />
          <p>{tr("Telegram will send this greeting automatically when an eligible chat starts or becomes active again.")}</p>
        </>}
      </fieldset>
      <button type="submit" className="mtg-action" disabled={busy || stale || greeting === undefined || !changed
        || !validShortcut || !validAudience}>{tr("Save greeting")}</button>
    </form>}
    {busy && <p role="status">{tr("Updating Business greeting…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </>;
}
