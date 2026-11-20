import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { FolderInvite } from "../core/contract.ts";

export type ImportFolderInvite = (url: string, token: string, ids: string[]) => Promise<"added" | "changed" | "unavailable">;

export function SharedFolderInvite({ url, folder, importFolder, openChannel }: {
  url: string;
  folder: FolderInvite;
  importFolder?: ImportFolderInvite;
  openChannel?: (id: string, username: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = selected.length === folder.chats.length;
  const [state, setState] = useState<"busy" | "added" | "changed" | "failed">();
  const [opening, setOpening] = useState<string>();
  const [unavailable, setUnavailable] = useState<string>();
  const channelRequest = useRef<AbortController>(undefined);
  useEffect(() => () => channelRequest.current?.abort(), []);

  async function open(id: string, username: string) {
    if (!openChannel || channelRequest.current) return;
    const request = new AbortController();
    channelRequest.current = request;
    setOpening(id);
    setUnavailable(undefined);
    const opened = await openChannel(id, username, request.signal).catch(() => false);
    if (request.signal.aborted) return;
    channelRequest.current = undefined;
    setOpening(undefined);
    if (!opened) setUnavailable(id);
  }

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
    {folder.alreadyAdded > 0 && <p>{folder.alreadyAdded} {folder.alreadyAdded === 1 ? tr("chat already in this folder") : tr("chats already in this folder")}.</p>}
    {folder.chats.length === 0 ? <p>{tr("No chats available to add.")}</p> : <fieldset>
      <legend>{tr("Chats to add")}</legend>
      <p>{tr("Telegram joins the selected chats if you haven’t joined them yet.")}</p>
      {folder.chats.length > 1 && <button type="button" className="mtg-action" disabled={!!state || !importFolder}
        onClick={() => setSelected(allSelected ? [] : folder.chats.map(({ id }) => id))}>
        {allSelected ? tr("Clear selection") : tr("Select all chats")}
      </button>}
      {folder.chats.map(({ id, title, channelUsername }) => <div key={id} className="mtg-folder-invite-chat">
        <label><input type="checkbox" checked={selected.includes(id)} disabled={!!state || !importFolder} onChange={(event) => {
          const checked = event.currentTarget.checked;
          setSelected((previous) => checked ? [...previous, id] : previous.filter((item) => item !== id));
        }} /> {title}</label>
        {channelUsername && openChannel && <button type="button" className="mtg-action" disabled={!!opening || state === "busy"}
          aria-label={tr("Open channel {0}", [title])} onClick={() => void open(id, channelUsername)}>
          {opening === id ? tr("Opening…") : tr("Open channel")}
        </button>}
        {unavailable === id && <p role="status">{tr("This public channel is unavailable.")}</p>}
      </div>)}
    </fieldset>}
    {importFolder && folder.chats.length > 0 && !state && <button type="button" className="mtg-action"
      disabled={!selected.length} onClick={() => void add()}>{tr("Add selected chats and folder")}</button>}
    {state === "busy" && <p role="status">{tr("Adding folder…")}</p>}
    {state === "added" && <p role="status">{tr("Folder added.")}</p>}
    {state === "changed" && <p role="alert">{tr("The folder invitation changed. Paste the link again to review it.")}</p>}
    {state === "failed" && <p role="alert">{tr("Could not confirm that Telegram added the folder. Check your folders before trying again.")}</p>}
  </li>;
}
