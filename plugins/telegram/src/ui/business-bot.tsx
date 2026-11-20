import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { businessBotRightLabels, businessBotRights, type BusinessBotConnection, type BusinessBotIdentity, type schemas } from "../core/contract.ts";
import { BusinessRecipientEditor, initialBusinessRecipients, SelectedPrivateChats, type BusinessRecipientChat } from "./business-recipients.tsx";

type View = z.infer<typeof schemas.businessBot.output>;
type Change = z.input<typeof schemas.saveBusinessBot.input>;
type Props = {
  read: () => Promise<View>;
  find: (username: string) => Promise<BusinessBotIdentity | null>;
  save: (input: Change) => Promise<z.infer<typeof schemas.saveBusinessBot.output>>;
  approve: (revision: string) => Promise<z.infer<typeof schemas.confirmBusinessBot.output>>;
  findRecipients: (query: string) => Promise<BusinessRecipientChat[]>;
  knownChats: readonly BusinessRecipientChat[];
};

export function BusinessBotSettings({ read, find, save, approve, findRecipients, knownChats }: Props) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const working = useRef(false);
  const [view, setView] = useState<View>();
  const [draft, setDraft] = useState<BusinessBotConnection | null>(null);
  const [identity, setIdentity] = useState<BusinessBotIdentity | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<"save" | "remove" | "approve">();
  const pending = view?.pending;
  const connectionDate = pending ? new Date(pending.date * 1000) : undefined;
  const handle = username.trim().replace(/^@/, "");
  const changed = JSON.stringify(draft) !== JSON.stringify(view?.connection);
  const overlap = draft?.recipients.chats.some((id) => draft.excludedChats.includes(id));

  async function load() {
    const current = await read();
    setView(current);
    setDraft(current.connection);
    setIdentity(current.identity);
    setUsername("");
    setStale(false);
  }

  async function run(operation: () => Promise<void>, failure: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(); }
    catch { setError(failure); }
    finally { working.current = false; setBusy(false); }
  }

  function findBot(event: FormEvent) {
    event.preventDefault();
    if (stale || pending || !/^[A-Za-z0-9_]{1,64}$/.test(handle)) return;
    void run(async () => {
      const bot = await find(handle);
      if (!bot) {
        setError("A Business-compatible bot was not found.");
        return;
      }
      setIdentity(bot);
      setDraft((current) => current?.botId === bot.id ? current : {
        botId: bot.id, recipients: initialBusinessRecipients, excludedChats: [], rights: [],
      });
    }, "Could not find the Business bot.");
  }

  function confirm() {
    if (!view || !review || stale || (review === "save" && (!draft || !changed || overlap || pending))
      || (review === "approve" && !pending)) return;
    const next = review === "remove" ? null : draft;
    setReview(undefined);
    void run(async () => {
      const result = await (review === "approve" && pending
        ? approve(pending.revision)
        : save({ connection: next, revision: view.revision }));
      if (result === "saved") {
        setStale(true);
        setNotice(review === "approve" ? "Business bot connection confirmed."
          : next ? "Business bot access saved." : "Business bot disconnected.");
        try { await load(); }
        catch { setError("Could not reload the Business bot. Reload before editing again."); }
      } else if (result === "changed") {
        setStale(true);
        setError("The connection changed in Telegram. Reload before editing.");
      } else setError("Telegram could not update the Business bot.");
    }, "Could not confirm the Business bot update.");
  }

  return <section aria-label={tr("Business bot")}>
    <h3>{tr("Business bot")}</h3>
    <button type="button" className="mtg-action" disabled={busy || !!review}
      onClick={() => void run(load, "Could not load the Business bot.")}>
      {view ? tr("Reload Business bot") : tr("Load Business bot")}
    </button>
    {view && <>
      {!view.connection && <p>{tr("No Business bot connected.")}</p>}
      {!pending && <form onSubmit={findBot}>
        <label>{tr("Bot username ")}<input value={username} maxLength={65}
          disabled={busy || stale || !!review} onChange={(event) => setUsername(event.target.value)} /></label>
        <button type="submit" className="mtg-action" disabled={busy || stale || !!review || !/^[A-Za-z0-9_]{1,64}$/.test(handle)}>{tr("Find bot")}</button>
      </form>}
      {draft && <>
        <p><bdi>{identity?.name ?? tr("Bot {0}", [draft.botId])}</bdi>{identity?.username && <> <bdi>@{identity.username}</bdi></>}</p>
        <fieldset disabled={busy || stale || !!review || !!pending}>
          <BusinessRecipientEditor label={tr("Private chats accessible to the bot")} recipients={draft.recipients}
            knownChats={knownChats} findRecipients={findRecipients}
            setRecipients={(recipients) => setDraft({ ...draft, recipients })} />
          <fieldset>
            <legend>{tr("Always excluded chats")}</legend>
            <SelectedPrivateChats label={tr("Find a private chat to exclude")} selected={draft.excludedChats} known={knownChats}
              find={findRecipients} change={(excludedChats) => setDraft({ ...draft, excludedChats })} />
          </fieldset>
          <fieldset>
            <legend>{tr("Bot permissions")}</legend>
            {businessBotRights.map((right) => <label key={right}>
              <input type="checkbox" checked={draft.rights.includes(right)} onChange={(event) => {
                const checked = event.target.checked;
                setDraft({ ...draft, rights: businessBotRights.filter((item) => item === right ? checked : draft.rights.includes(item)) });
              }} />{businessBotRightLabels[right]}
            </label>)}
          </fieldset>
        </fieldset>
        {overlap && <p role="alert">{tr("A chat cannot be both selected and always excluded.")}</p>}
        {!pending && <button type="button" className="mtg-action" disabled={busy || stale || !!review || !changed || overlap}
          onClick={() => setReview("save")}>{tr("Review bot access")}</button>}
      </>}
      {pending && connectionDate && <div>
        <p>{tr("This Business bot connection is awaiting confirmation.")}</p>
        <p><time dateTime={connectionDate.toISOString()}>{connectionDate.toLocaleString(uiLocale)}</time>
          {pending.device && <> · <bdi>{pending.device}</bdi></>}
          {pending.location && <> · <bdi>{pending.location}</bdi></>}
        </p>
        <button type="button" className="mtg-action" disabled={busy || stale || !!review}
          onClick={() => setReview("approve")}>{tr("Review pending connection")}</button>
      </div>}
      {view.connection && <button type="button" className="mtg-action" disabled={busy || stale || !!review}
        onClick={() => setReview("remove")}>{tr("Disconnect bot")}</button>}
      {review && <div role="group" aria-label={tr("Confirm Business bot access")}>
        <p>{review === "save" ? tr("Allow this bot to access the selected chats with the permissions above?")
          : review === "approve" ? <>{tr("Confirm the connection for ")}<bdi>{view.identity?.name ?? tr("bot {0}", [view.connection?.botId])}</bdi>{tr(" with the access shown above?")}</>
          : tr("Disconnect the Business bot from your account?")}</p>
        <button type="button" className="mtg-action" onClick={confirm}>
          {review === "save" ? tr("Save bot access") : review === "approve" ? tr("Confirm connection") : tr("Confirm disconnect")}
        </button>
        <button type="button" className="mtg-action" onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
      </div>}
    </>}
    {busy && <p role="status">{tr("Updating Business bot settings…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </section>;
}
