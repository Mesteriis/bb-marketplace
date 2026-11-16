import { FolderUpdates, type FolderUpdatesActions } from "./folder-updates.tsx";
import { FolderInvites, type FolderInviteActions } from "./folder-invites.tsx";
import { FolderTags, type FolderTagsActions } from "./folder-tags.tsx";
import { folderColors } from "./folder-colors.ts";
import { FolderOrder, type SaveFolderOrder } from "./folder-order.tsx";
import { FolderCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { folderIconNames, folderRuleLabels, type FolderDraft, type FolderEditor, type FolderMembership, type RecommendedFolder, type TelegramFolder } from "../core/contract.ts";

export type FolderActions = {
  limit: () => Promise<number | null>;
  folderUpdates?: FolderUpdatesActions;
  invites?: FolderInviteActions;
  tags?: FolderTagsActions;
  reorder?: SaveFolderOrder;
  recommend?: () => Promise<RecommendedFolder[]>;
  addRecommended?: (token: string) => Promise<TelegramFolder>;
  load: (id: number) => Promise<FolderEditor>;
  save: (draft: FolderDraft, id?: number) => Promise<TelegramFolder>;
  remove: (id: number, title: string) => Promise<boolean>;
  memberships: (chatId: string) => Promise<FolderMembership[]>;
  setMembership: (id: number, chatId: string, mode: FolderMembership["mode"]) => Promise<boolean>;
};

const empty = (): FolderEditor => ({ title: "", rules: [], shareable: false });

export function FolderSettings({ folders, actions }: { folders: TelegramFolder[]; actions: FolderActions }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [orderSession, setOrderSession] = useState(0);
  const [id, setId] = useState<number>();
  const [draft, setDraft] = useState<FolderEditor>(empty);
  const [originalIcon, setOriginalIcon] = useState<FolderDraft["icon"]>();
  const [original, setOriginal] = useState("");
  const [limit, setLimit] = useState<number | null>(null);
  const atLimit = id === undefined && limit !== null && folders.length >= limit;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [recommended, setRecommended] = useState<RecommendedFolder[]>();
  const [loadingRecommended, setLoadingRecommended] = useState(false);

  async function loadRecommended() {
    if (!actions.recommend || busy || loadingRecommended) return;
    setLoadingRecommended(true);
    setStatus("");
    try {
      setRecommended(await actions.recommend());
    } catch {
      setStatus("Could not load recommended folders.");
    } finally {
      setLoadingRecommended(false);
    }
  }

  async function addRecommended(token: string) {
    if (!actions.addRecommended || busy || loadingRecommended || atLimit) return;
    setBusy(true);
    setStatus("");
    try {
      const saved = await actions.addRecommended(token);
      setRecommended((previous) => previous?.filter((folder) => folder.title !== saved.title));
      setStatus("Recommended folder added.");
    } catch {
      setStatus("Telegram did not add the folder. Refresh recommendations and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function select(folderId?: number) {
    setId(folderId);
    setConfirm(false);
    setStatus("");
    setOriginal("");
    setOriginalIcon(undefined);
    setDraft(empty());
    if (folderId === undefined) return;
    setBusy(true);
    try {
      const loaded = await actions.load(folderId);
      setDraft(loaded);
      setOriginal(loaded.title);
      setOriginalIcon(loaded.icon);
    } catch { setStatus("Could not load this folder."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (atLimit) return;
    setBusy(true);
    setStatus("");
    try {
      const saved = await actions.save({ title: draft.title, rules: draft.rules, ...(draft.canEditColor ? { color: draft.color } : {}),
        ...(draft.icon === originalIcon ? {} : { icon: draft.icon }) }, id);
      setId(saved.id);
      setOriginal(saved.title);
      setOriginalIcon(draft.icon);
      setDraft((previous) => ({ ...previous, title: saved.title }));
      setStatus("Folder saved.");
    } catch { setStatus("Telegram did not save the folder."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (id === undefined || !original) return;
    setBusy(true);
    try {
      if (await actions.remove(id, original)) {
        await select();
        setStatus("Folder deleted.");
      } else setStatus("The folder changed. Reopen it and try again.");
    } catch { setStatus("Could not delete this folder."); }
    finally { setBusy(false); setConfirm(false); }
  }

  return <>
    <button type="button" aria-label="Manage folders" aria-haspopup="dialog" title="Manage folders"
      onClick={() => {
        void select();
        setLimit(null);
        setRecommended(undefined);
        setOrderSession((current) => current + 1);
        void actions.limit().then(setLimit).catch(() => {});
        dialog.current?.showModal();
      }}><FolderCog size={20} aria-hidden="true" /><span>Folders</span></button>
    <dialog ref={dialog} className="mtg-agent-settings" aria-label="Manage folders" onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy && draft.title.trim() && (id === undefined || original)) void save(); }}>
        <label>Folder <select value={id ?? ""} disabled={busy} onChange={(event) => void select(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">New folder</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.title}</option>)}
        </select></label>
        <label>Name <input value={draft.title} maxLength={12} disabled={busy || (id !== undefined && !original)}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        {id !== undefined && draft.icon !== undefined && <label>Folder icon
          <select value={draft.icon ?? ""} disabled={busy || !original} onChange={(event) => {
            const icon = folderIconNames.find((name) => name === event.currentTarget.value) ?? null;
            setDraft({ ...draft, icon });
          }}>
            <option value="">Automatic</option>
            {folderIconNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {id !== undefined && draft.canEditColor && <label>Folder color
          <select value={draft.color ?? -1} disabled={busy || !original}
            onChange={(event) => setDraft({ ...draft, color: Number(event.currentTarget.value) })}>
            <option value={-1}>No color</option>
            {folderColors.map(({ name }, color) => <option key={color} value={color}>{name}</option>)}
          </select>
        </label>}
        {!draft.shareable && <fieldset disabled={busy || (id !== undefined && !original)}>
          <legend>Chat rules</legend>
          {(Object.entries(folderRuleLabels) as [FolderDraft["rules"][number], string][]).map(([rule, label]) =>
            <label key={rule}><input type="checkbox" checked={draft.rules.includes(rule)}
              onChange={(event) => setDraft({ ...draft, rules: event.target.checked ? [...draft.rules, rule] : draft.rules.filter((value) => value !== rule) })} /> {label}</label>)}
        </fieldset>}
        {id === undefined && actions.recommend && actions.addRecommended && <details>
          <summary>Recommended folders</summary>
          <button className="mtg-action" type="button" disabled={busy || loadingRecommended}
            onClick={() => void loadRecommended()}>{recommended ? "Refresh recommendations" : "Show recommendations"}</button>
          {loadingRecommended && <p role="status">Loading recommended folders…</p>}
          {recommended?.length === 0 && <p>No recommended folders available.</p>}
          {!!recommended?.length && <ul>{recommended.map(({ token, title, description }) => <li key={token}>
            <strong>{title}</strong>{description && <p>{description}</p>}
            <button className="mtg-action" type="button" disabled={busy || loadingRecommended || atLimit}
              onClick={() => void addRecommended(token)}>Add {title}</button>
          </li>)}</ul>}
        </details>}
        {atLimit && <p role="status">Telegram folder limit reached ({limit}). You can still edit existing folders.</p>}
        {status && <p role="status">{status}</p>}
        <button className="mtg-action" type="submit" disabled={busy || atLimit || !draft.title.trim() || (id !== undefined && !original)}>Save folder</button>
        {id !== undefined && original && !confirm && <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirm(true)}>Delete folder</button>}
        {confirm && <>
          <p>Delete this folder and keep its chats?</p>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => void remove()}>Confirm folder deletion</button>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirm(false)}>Keep folder</button>
        </>}
        <button className="mtg-action" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Done</button>
      </form>
      {actions.folderUpdates && id !== undefined && draft.shareable && <FolderUpdates key={`updates:${id}`}
        id={id} actions={actions.folderUpdates} disabled={busy} />}
      {actions.invites && id !== undefined && original && <FolderInvites key={id}
        id={id} actions={actions.invites} disabled={busy} />}
      {actions.tags && <FolderTags key={`tags:${orderSession}`} actions={actions.tags} disabled={busy} />}
      {actions.reorder && folders.length > 1 && <FolderOrder key={orderSession} folders={folders} save={actions.reorder} disabled={busy} />}
    </dialog>
  </>;
}

export function ChatFolderMemberships({ chatId, folders, actions }: { chatId: string; folders: TelegramFolder[]; actions: FolderActions }) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<FolderMembership[]>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    void actions.memberships(chatId).then(
      (result) => { if (current) { setRows(result); setError(false); } },
      () => { if (current) setError(true); },
    );
    return () => { current = false; };
  }, [actions, chatId, revision, expanded]);

  async function change(id: number, mode: FolderMembership["mode"]) {
    setBusy(true);
    try {
      if (!await actions.setMembership(id, chatId, mode)) throw new Error("Telegram refused the change.");
      setRows((previous) => previous?.map((row) => row.id === id ? { ...row, mode } : row));
      setError(false);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Chat folders</summary>
    {error && <p role="alert">Could not read or update folders. <button type="button" className="mtg-action" disabled={busy}
      onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}
    {!rows && !error && <p role="status">Loading folders…</p>}
    {rows?.map(({ id, mode, shareable }) => {
      const folder = folders.find((item) => item.id === id);
      return folder && <label key={id}>{folder.title} <select value={mode} disabled={busy}
        onChange={(event) => void change(id, event.target.value as FolderMembership["mode"])}>
        <option value="automatic">Automatic</option>
        <option value="include">Include</option>
        {!shareable && <option value="exclude">Exclude</option>}
      </select></label>;
    })}
  </details>;
}
