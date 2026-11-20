import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { FolderInvite } from "../core/contract.ts";

export type FolderUpdatesActions = {
  load: (id: number) => Promise<FolderInvite | null>;
  add: (id: number, token: string, ids: string[]) => Promise<boolean>;
  dismiss: (id: number, token: string) => Promise<boolean>;
};

export function FolderUpdates({ id, actions, disabled }: { id: number; actions: FolderUpdatesActions; disabled: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [preview, setPreview] = useState<FolderInvite | null>();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function check() {
    if (busy || disabled) return;
    setBusy(true);
    setNotice("");
    setSelected([]);
    setConfirmDismiss(false);
    setPreview(undefined);
    try { setPreview(await actions.load(id)); }
    catch { setNotice("Could not check for new chats."); }
    finally { setBusy(false); }
  }

  async function apply(dismiss: boolean) {
    if (!preview?.chats.length || (dismiss ? !confirmDismiss : !selected.length) || busy || disabled) return;
    setBusy(true);
    setNotice("");
    try {
      const applied = dismiss ? await actions.dismiss(id, preview.token) : await actions.add(id, preview.token, selected);
      setNotice(applied ? dismiss ? "Folder update hidden." : "New chats added." : "The folder updates changed. Check again.");
    } catch { setNotice(dismiss ? "Telegram did not confirm hiding the update." : "Telegram did not confirm adding the new chats."); }
    finally { setPreview(undefined); setSelected([]); setConfirmDismiss(false); setBusy(false); }
  }

  return <details onToggle={(event) => { if (!event.currentTarget.open) setConfirmDismiss(false); }}>
    <summary>{tr("New chats from the owner")}</summary>
    <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => void check()}>{tr("Check for new chats")}</button>
    {preview === null && <p>{tr("Folder updates are unavailable.")}</p>}
    {preview?.chats.length === 0 && <p>{tr("No new chats to add.")}</p>}
    {!!preview?.chats.length && <fieldset disabled={disabled || busy}>
      <legend>{tr("New chats to add")}</legend>
      <p>{tr("Telegram joins the selected chats if you haven’t joined them yet.")}</p>
      {preview.chats.map(({ id: chatId, title }) => <label key={chatId} className="mtg-folder-invite-chat">
        <input type="checkbox" checked={selected.includes(chatId)} onChange={(event) => {
          const checked = event.currentTarget.checked;
          setSelected((previous) => checked ? [...previous, chatId] : previous.filter((item) => item !== chatId));
        }} /> {title}
      </label>)}
      {confirmDismiss ? <>
        <p>{tr("Hide these suggestions for this folder?")}</p>
        <button type="button" className="mtg-action" onClick={() => void apply(true)}>{tr("Confirm hide")}</button>
        <button type="button" className="mtg-action" onClick={() => setConfirmDismiss(false)}>{tr("Keep suggestions")}</button>
      </> : <>
        <button type="button" className="mtg-action" disabled={!selected.length} onClick={() => void apply(false)}>{tr("Add selected new chats")}</button>
        <button type="button" className="mtg-action" onClick={() => setConfirmDismiss(true)}>{tr("Hide suggestions")}</button>
      </>}
    </fieldset>}
    {busy && <p role="status">{tr("Checking Telegram folder updates…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </details>;
}
