import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";

import { CopyTelegramPublicLink } from "./copy-message-reference.tsx";

type View = { username: string; activeUsernames?: string[]; otherUsernames: string[]; editable: boolean };
type Result = "saved" | "changed" | "invalid" | "occupied" | "purchasable" | "limit" | "unavailable";
export type ChatPublicUsernameActions = {
  load: (id: string) => Promise<View | null>;
  save: (id: string, username: string, expected: string) => Promise<Result>;
};

const messages: Record<Exclude<Result, "saved">, string> = {
  changed: "The username changed in Telegram. Reload it before trying again.",
  invalid: "Telegram does not accept this username.",
  occupied: "This username is already in use.",
  purchasable: "Telegram lists this username as a collectible.",
  limit: "Telegram has reached its limit for public chats on this account.",
  unavailable: "Telegram did not confirm the username change.",
};

export function ChatPublicUsername({ chatId, actions }: { chatId: string; actions: ChatPublicUsernameActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View | null>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const username = input.trim().replace(/^@/, "");
  const valid = /^[A-Za-z0-9_]{0,32}$/.test(username);
  const active = view?.activeUsernames ?? view?.otherUsernames ?? [];

  useEffect(() => {
    if (!open) return;
    let active = true;
    setView(undefined);
    setError("");
    setSaved(false);
    void actions.load(chatId).then((result) => {
      if (active) { setView(result); setInput(result?.username ?? ""); }
    }, () => { if (active) setError("Could not load the public username."); });
    return () => { active = false; };
  }, [open, chatId, actions, revision]);

  async function save() {
    if (!view?.editable || view.username === username || !valid || busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const result = await actions.save(chatId, username, view.username);
      if (result === "saved") {
        const updated = await actions.load(chatId).catch(() => null);
        setSaved(true);
        if (updated) {
          setView(updated);
          setInput(updated.username);
        } else {
          setView(undefined);
          setError("Username saved. Reload to see the current public links.");
        }
      } else {
        if (result === "changed") setView(undefined);
        setError(messages[result]);
      }
    } catch {
      setView(undefined);
      setError(messages.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Public username")}</summary>
    {open && <>
      {view === undefined && !error && <p role="status">{tr("Loading public username…")}</p>}
      {view === null && <p>{tr("Public username settings are unavailable for this chat.")}</p>}
      {view && <>
        {view.activeUsernames === undefined && view.username && <p><bdi>@{view.username}</bdi></p>}
        {!active.length && view.activeUsernames !== undefined && <p>{tr("No public links.")}</p>}
        {active.length > 0 && <ul aria-label={tr("Public usernames")}>{active.map((name) => <li key={name}>
            <bdi>@{name}</bdi> <CopyTelegramPublicLink name={name} />
          </li>)}</ul>}
        {view.editable && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>{tr("Editable username ")}<input value={input} maxLength={33} disabled={busy}
            onChange={(event) => { setInput(event.target.value); setSaved(false); }} /></label>
          <p>{username ? tr("Anyone can find the chat by its public username.") : tr("Other public usernames may keep the chat public.")}</p>
          <button type="submit" className="mtg-action" disabled={busy || !valid || view.username === username}>
            {username ? tr("Save username") : tr("Remove username")}
          </button>
        </form>}
      </>}
      {error && <p role="alert">{tr(error)} {!view && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload username")}</button>}</p>}
      {saved && <p role="status">{tr("Public username saved.")}</p>}
    </>}
  </details>;
}
