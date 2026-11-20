import { useTelegramLocale } from "./i18n/index.tsx";
import { EditFolderInviteChats } from "./edit-folder-invite-chats.tsx";
import { CreateFolderInvite } from "./create-folder-invite.tsx";
import { useState } from "react";
import type { FolderInviteEditor, FolderShareChat, ManagedFolderInvite } from "../core/contract.ts";

export type FolderInviteActions = {
  shareChats: (id: number) => Promise<FolderShareChat[] | null>;
  create: (id: number, name: string, ids: string[]) => Promise<ManagedFolderInvite | null>;
  load: (id: number) => Promise<ManagedFolderInvite[] | null>;
  editChats: (id: number, url: string) => Promise<FolderInviteEditor | null>;
  saveChats: (id: number, url: string, token: string, ids: string[]) => Promise<ManagedFolderInvite | null>;
  rename: (id: number, url: string, expected: string, name: string) => Promise<ManagedFolderInvite | null>;
  revoke: (id: number, url: string, name: string) => Promise<boolean>;
};

export function FolderInvites({ id, actions, disabled }: { id: number; actions: FolderInviteActions; disabled: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [rows, setRows] = useState<ManagedFolderInvite[] | null>();
  const [editing, setEditing] = useState<{ url: string; name: string }>();
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    if (disabled || busy) return;
    setBusy(true);
    setConfirm(undefined);
    setEditing(undefined);
    setStatus("");
    try { setRows(await actions.load(id)); }
    catch { setStatus("Could not load folder invite links."); }
    finally { setBusy(false); }
  }

  async function rename(link: ManagedFolderInvite) {
    if (disabled || busy || editing?.url !== link.url || editing.name.trim() === link.name) return;
    setBusy(true);
    setStatus("");
    try {
      const next = await actions.rename(id, link.url, link.name, editing.name.trim());
      if (next) {
        setRows((current) => current?.map((row) => row.url === link.url ? next : row));
        setStatus("Folder link renamed.");
      } else setStatus("The link changed. Refresh the list before trying again.");
    } catch { setStatus("Telegram did not confirm renaming the link. Refresh the list."); }
    finally { setEditing(undefined); setBusy(false); }
  }

  async function revoke(link: ManagedFolderInvite) {
    if (disabled || busy || confirm !== link.url) return;
    setBusy(true);
    setStatus("");
    try {
      if (await actions.revoke(id, link.url, link.name)) {
        setRows((current) => current?.filter(({ url }) => url !== link.url));
        setStatus("Folder link revoked.");
      } else setStatus("The link changed. Refresh the list before trying again.");
    } catch { setStatus("Telegram did not confirm revoking the link. Refresh the list."); }
    finally { setConfirm(undefined); setBusy(false); }
  }

  return <details onToggle={(event) => { if (!event.currentTarget.open) { setConfirm(undefined); setEditing(undefined); } }}>
    <summary>{tr("Folder invite links")}</summary>
    <button type="button" className="mtg-action" disabled={disabled || busy}
      onClick={() => void load()}>{rows === undefined ? tr("Load folder links") : tr("Refresh folder links")}</button>
    {rows === null && <p>{tr("Folder invite links are unavailable for this connection.")}</p>}
    {rows?.length === 0 && <p>{tr("No invite links for this folder.")}</p>}
    {!!rows?.length && <ul>{rows.map((row) => <li key={row.url}>
      <strong>{row.name || tr("Folder invitation")}</strong> · {row.chatCount} {row.chatCount === 1 ? tr("chat") : tr("chats")}
      {editing?.url === row.url ? <form onSubmit={(event) => { event.preventDefault(); void rename(row); }}>
        <label>{tr("Link name ")}<input maxLength={32} disabled={disabled || busy} value={editing.name}
          onChange={(event) => setEditing({ url: row.url, name: event.currentTarget.value })} /></label>
        <button type="submit" className="mtg-action" disabled={disabled || busy || editing.name.trim() === row.name}>{tr("Save link name")}</button>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={() => setEditing(undefined)}>{tr("Cancel rename")}</button>
      </form> : confirm === row.url ? <>
        <p>{tr("Anyone with this link will lose the ability to use it.")}</p>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={() => void revoke(row)}>{tr("Confirm revoke")}</button>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={() => setConfirm(undefined)}>{tr("Keep link")}</button>
      </> : <>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(row.url);
              setStatus("Folder link copied.");
            } catch { setStatus("Could not copy the folder link."); }
          }}>{tr("Copy link")}</button>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={() => { setEditing(undefined); setConfirm(row.url); }}>{tr("Revoke link")}</button>
        <button type="button" className="mtg-action" disabled={disabled || busy}
          onClick={() => { setConfirm(undefined); setEditing({ url: row.url, name: row.name }); }}>{tr("Rename link")}</button>
        <EditFolderInviteChats id={id} url={row.url} actions={actions} disabled={disabled || busy}
          saved={(link) => setRows((current) => current?.map((item) => item.url === link.url ? link : item))} />
      </>}
    </li>)}</ul>}
    <CreateFolderInvite id={id} actions={actions} disabled={disabled || busy}
      created={(link) => { setRows((current) => [...(current ?? []), link]); setStatus("Folder link created."); }} />
    {busy && <p role="status">{tr("Updating folder links…")}</p>}
    {status && <p role="status">{tr(status)}</p>}
  </details>;
}
