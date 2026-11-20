import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { FolderShareChat, ManagedFolderInvite } from "../core/contract.ts";
import type { FolderInviteActions } from "./folder-invites.tsx";

export function CreateFolderInvite({ id, actions, disabled, created }: {
  id: number;
  actions: Pick<FolderInviteActions, "shareChats" | "create">;
  disabled: boolean;
  created: (link: ManagedFolderInvite) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [choices, setChoices] = useState<FolderShareChat[] | null>();
  const [name, setName] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    setIds([]);
    try { setChoices(await actions.shareChats(id)); }
    catch { setError("Could not load shareable chats."); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!ids.length || busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      const result = await actions.create(id, name.trim(), ids);
      if (result) {
        created(result);
        setChoices(undefined);
        setName("");
      } else setError("The selected chats changed. Reload shareable chats and try again.");
    } catch { setError("Telegram did not confirm creating the link. Refresh folder links before trying again."); }
    finally { setIds([]); setBusy(false); }
  }

  return <details>
    <summary>{tr("Create folder link")}</summary>
    <button type="button" className="mtg-action" disabled={busy || disabled} onClick={() => void load()}>
      {choices === undefined ? tr("Load shareable chats") : tr("Reload shareable chats")}
    </button>
    {choices === null && <p>{tr("Telegram requires a folder with only pinned or explicitly included chats.")}</p>}
    {choices?.length === 0 && <p>{tr("No chats in this folder can be shared.")}</p>}
    {!!choices?.length && <fieldset disabled={busy || disabled}>
      <legend>{tr("Chats to share")}</legend>
      <p>{tr("Anyone with the link can use it to join the selected chats.")}</p>
      {choices.map(({ id: chatId, title }) => <label key={chatId} className="mtg-folder-invite-chat">
        <input type="checkbox" checked={ids.includes(chatId)} onChange={(event) => {
          const checked = event.currentTarget.checked;
          setIds((previous) => checked ? [...previous, chatId] : previous.filter((value) => value !== chatId));
        }} /> {title}
      </label>)}
      {choices.some(({ id: chatId, upgradesGroup }) => upgradesGroup && ids.includes(chatId))
        && <p>{tr("Telegram will convert selected basic groups to supergroups when it creates the link.")}</p>}
      <label>{tr("Link name ")}<input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={32} /></label>
      <button type="button" className="mtg-action" disabled={!ids.length} onClick={() => void create()}>{tr("Create invite link")}</button>
    </fieldset>}
    {busy && <p role="status">{tr("Updating folder invitation…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
  </details>;
}
