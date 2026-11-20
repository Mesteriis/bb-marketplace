import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { FolderInviteEditor, ManagedFolderInvite } from "../core/contract.ts";
import type { FolderInviteActions } from "./folder-invites.tsx";

export function EditFolderInviteChats({ id, url, actions, disabled, saved }: {
  id: number;
  url: string;
  actions: Pick<FolderInviteActions, "editChats" | "saveChats">;
  disabled: boolean;
  saved: (link: ManagedFolderInvite) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [editor, setEditor] = useState<FolderInviteEditor | null>();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const changed = editor && (ids.length !== editor.selected.length || ids.some((chatId) => !editor.selected.includes(chatId)));

  async function load() {
    if (busy || disabled) return;
    setBusy(true);
    setEditor(undefined);
    setNotice("");
    try {
      const next = await actions.editChats(id, url);
      setEditor(next);
      setIds(next?.selected ?? []);
    } catch { setNotice("Could not load the shared chats."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!editor || !changed || !ids.length || busy || disabled) return;
    setBusy(true);
    setNotice("");
    try {
      const link = await actions.saveChats(id, url, editor.token, ids);
      if (link) {
        saved(link);
        setNotice("Shared chats updated.");
      } else setNotice("The invitation or eligible chats changed. Reload before saving.");
    } catch { setNotice("Telegram did not confirm the update. Reload the shared chats."); }
    finally { setEditor(undefined); setBusy(false); }
  }

  return <details>
    <summary>{tr("Edit shared chats")}</summary>
    <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => void load()}>{tr("Load shared chats")}</button>
    {editor === null && <p>{tr("Telegram no longer offers all of the chats on this link for sharing.")}</p>}
    {editor && <fieldset disabled={disabled || busy}>
      <legend>{tr("Chats accessible through this link")}</legend>
      {editor.choices.map(({ id: chatId, title }) => <label key={chatId} className="mtg-folder-invite-chat">
        <input type="checkbox" checked={ids.includes(chatId)} onChange={(event) => {
          const checked = event.currentTarget.checked;
          setIds((previous) => checked ? [...previous, chatId] : previous.filter((value) => value !== chatId));
        }} /> {title}
      </label>)}
      {editor.choices.some(({ id: chatId, upgradesGroup }) => upgradesGroup && ids.includes(chatId))
        && <p>{tr("Telegram will convert selected basic groups to supergroups when it updates the link.")}</p>}
      <button type="button" className="mtg-action" disabled={!changed || !ids.length} onClick={() => void save()}>{tr("Save shared chats")}</button>
    </fieldset>}
    {busy && <p role="status">{tr("Updating shared chats…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </details>;
}
