import { useState } from "react";
import type { FolderInvite } from "../core/contract.ts";

export type ImportFolderInvite = (url: string, token: string, ids: string[]) => Promise<"added" | "changed" | "unavailable">;

export function SharedFolderInvite({ url, folder, importFolder }: {
  url: string;
  folder: FolderInvite;
  importFolder?: ImportFolderInvite;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = selected.length === folder.chats.length;
  const [state, setState] = useState<"busy" | "added" | "changed" | "failed">();

  async function add() {
    if (!importFolder || !selected.length || state) return;
    setState("busy");
    try {
      const result = await importFolder(url, folder.token, selected);
      setState(result === "unavailable" ? "failed" : result);
    } catch { setState("failed"); }
  }

  return <li className="mtg-empty">
    <h3>{folder.title}</h3>
    {folder.alreadyAdded > 0 && <p>{folder.alreadyAdded} {folder.alreadyAdded === 1 ? "chat already in this folder" : "chats already in this folder"}.</p>}
    {folder.chats.length === 0 ? <p>No chats available to add.</p> : <fieldset disabled={!!state || !importFolder}>
      <legend>Chats to add</legend>
      <p>Telegram joins the selected chats if you haven’t joined them yet.</p>
      {folder.chats.length > 1 && <button type="button" className="mtg-action"
        onClick={() => setSelected(allSelected ? [] : folder.chats.map(({ id }) => id))}>
        {allSelected ? "Clear selection" : "Select all chats"}
      </button>}
      {folder.chats.map(({ id, title }) => <label key={id} className="mtg-folder-invite-chat">
        <input type="checkbox" checked={selected.includes(id)} onChange={(event) => {
          const checked = event.currentTarget.checked;
          setSelected((previous) => checked ? [...previous, id] : previous.filter((item) => item !== id));
        }} /> {title}
      </label>)}
    </fieldset>}
    {importFolder && folder.chats.length > 0 && !state && <button type="button" className="mtg-action"
      disabled={!selected.length} onClick={() => void add()}>Add selected chats and folder</button>}
    {state === "busy" && <p role="status">Adding folder…</p>}
    {state === "added" && <p role="status">Folder added.</p>}
    {state === "changed" && <p role="alert">The folder invitation changed. Paste the link again to review it.</p>}
    {state === "failed" && <p role="alert">Could not confirm that Telegram added the folder. Check your folders before trying again.</p>}
  </li>;
}
