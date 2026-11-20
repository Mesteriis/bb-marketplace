import { useTelegramLocale } from "./i18n/index.tsx";
import { FolderUpdates, type FolderUpdatesActions } from "./folder-updates.tsx";
import { FolderInvites, type FolderInviteActions } from "./folder-invites.tsx";
import { FolderTags, type FolderTagsActions } from "./folder-tags.tsx";
import { folderColors } from "./folder-colors.ts";
import { FolderOrder, type SaveFolderOrder } from "./folder-order.tsx";
import { FolderCog } from "lucide-react";
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { folderIconNames, folderRuleLabels, type FolderDraft, type FolderEditor, type FolderMembership, type RecommendedFolder, type TelegramFolder } from "../core/contract.ts";
import { folderChoices, folderParentPaths, folderTitleParts } from "../core/folder-tree.ts";

export type FolderActions = {
  limit: () => Promise<number | null>;
  folderUpdates?: FolderUpdatesActions;
  invites?: FolderInviteActions;
  tags?: FolderTagsActions;
  reorder?: SaveFolderOrder;
  canMoveMain?: () => Promise<boolean>;
  recommend?: () => Promise<RecommendedFolder[]>;
  addRecommended?: (token: string) => Promise<TelegramFolder>;
  load: (id: number) => Promise<FolderEditor>;
  save: (draft: FolderDraft, id?: number, expectedRevision?: string) => Promise<TelegramFolder | null>;
  remove: (id: number, title: string) => Promise<boolean>;
  memberships: (chatId: string) => Promise<FolderMembership[]>;
  setMembership: (id: number, chatId: string, mode: FolderMembership["mode"]) => Promise<boolean>;
};

const empty = (): FolderEditor => ({ title: "", rules: [], shareable: false });

export type FolderSettingsController = { open: (folderId?: number) => void };

export function FolderSettings({ folders, mainPosition, actions, controller, hideTrigger = false }: {
  hideTrigger?: boolean;
  folders: TelegramFolder[];
  mainPosition?: number;
  actions: FolderActions;
  controller?: Ref<FolderSettingsController>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameHelp = useId();
  const [orderSession, setOrderSession] = useState(0);
  const [id, setId] = useState<number>();
  const [draft, setDraft] = useState<FolderEditor>(empty);
  const [originalIcon, setOriginalIcon] = useState<FolderDraft["icon"]>();
  const [original, setOriginal] = useState("");
  const [conflict, setConflict] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const atLimit = id === undefined && limit !== null && folders.length >= limit;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [recommended, setRecommended] = useState<RecommendedFolder[]>();
  const [loadingRecommended, setLoadingRecommended] = useState(false);
  const path = folderTitleParts(draft.title.trim());
  const parent = path.slice(0, -1).join(".");
  const leaf = path.at(-1) ?? "";
  const parents = folderParentPaths(folders, original);
  if (parent && !parents.includes(parent)) parents.push(parent);
  const tooLong = draft.title.trim().length > 12;
  const canSave = !busy && !atLimit && !conflict && !tooLong && !!draft.title.trim() && (id === undefined || !!original);

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
    setConflict(false);
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
    if (atLimit || conflict) return;
    setBusy(true);
    setStatus("");
    try {
      const saved = await actions.save({ title: draft.title, rules: draft.rules, ...(draft.canEditColor ? { color: draft.color } : {}),
        ...(draft.icon === originalIcon ? {} : { icon: draft.icon }) }, id, ...(draft.revision ? [draft.revision] : []));
      if (!saved) {
        setConflict(true);
        setStatus("Folder settings changed in Telegram. Reload the folder before saving.");
        return;
      }
      setId(saved.id);
      setOriginal(saved.title);
      setOriginalIcon(draft.icon);
      setDraft((previous) => ({ ...previous, title: saved.title }));
      if (draft.revision || id === undefined) {
        const current = await actions.load(saved.id).catch(() => undefined);
        if (current) {
          setDraft(current);
          setOriginal(current.title);
          setOriginalIcon(current.icon);
        } else {
          setConflict(true);
          setStatus("Folder saved. Reload the folder before making more changes.");
          return;
        }
      }
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

  function open(folderId?: number) {
    const element = dialog.current;
    if (!element || element.open) return;
    void select(folderId);
    setLimit(null);
    setRecommended(undefined);
    setOrderSession((current) => current + 1);
    void actions.limit().then(setLimit).catch(() => {});
    element.showModal();
  }

  useImperativeHandle(controller, () => ({ open }));
  return <>
    {!hideTrigger && <button type="button" aria-label={tr("Manage folders")} aria-haspopup="dialog" title={tr("Manage folders")}
      onClick={() => open()}><FolderCog size={20} aria-hidden="true" /><span>{tr("Folders")}</span></button>}
    <dialog ref={dialog} className="mtg-agent-settings mtg-folder-settings" aria-label={tr("Manage folders")} onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (canSave) void save(); }}>
        <label>{tr("Folder ")}<select value={id ?? ""} disabled={busy} onChange={(event) => void select(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">{tr("New folder")}</option>
          {folderChoices(folders).map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label>{tr("Name ")}<input value={draft.title} maxLength={12} aria-describedby={nameHelp} disabled={busy || (id !== undefined && !original)}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>{tr("Parent folder ")}<select value={parent} disabled={busy || !leaf || leaf.includes(".") || (id !== undefined && !original)}
          aria-describedby={nameHelp} onChange={(event) => {
            const selected = event.currentTarget.value;
            setDraft({ ...draft, title: selected ? `${selected}.${leaf}` : leaf });
          }}>
          <option value="">{tr("Top level")}</option>
          {parents.map((name) => <option key={name} value={name}>{folderTitleParts(name).join(" / ")}</option>)}
        </select></label>
        <p id={nameHelp}>{path.length > 1 ? <>{tr("Sidebar path ")}<bdi>{path.join(" / ")}</bdi></>
          : <>{tr("Use periods to create nested folders.")}</>}</p>
        {tooLong && <p role="alert">{tr("The full Telegram folder name must fit in 12 characters.")}</p>}
        {id !== undefined && draft.icon !== undefined && <label>{tr("Folder icon")}<select value={draft.icon ?? ""} disabled={busy || !original} onChange={(event) => {
            const icon = folderIconNames.find((name) => name === event.currentTarget.value) ?? null;
            setDraft({ ...draft, icon });
          }}>
            <option value="">{tr("Automatic")}</option>
            {folderIconNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {id !== undefined && draft.canEditColor && <label>{tr("Folder color")}<select value={draft.color ?? -1} disabled={busy || !original}
            onChange={(event) => setDraft({ ...draft, color: Number(event.currentTarget.value) })}>
            <option value={-1}>{tr("No color")}</option>
            {folderColors.map(({ name }, color) => <option key={color} value={color}>{name}</option>)}
          </select>
        </label>}
        {!draft.shareable && <fieldset disabled={busy || (id !== undefined && !original)}>
          <legend>{tr("Chat rules")}</legend>
          {(Object.entries(folderRuleLabels) as [FolderDraft["rules"][number], string][]).map(([rule, label]) =>
            <label key={rule}><input type="checkbox" checked={draft.rules.includes(rule)}
              onChange={(event) => setDraft({ ...draft, rules: event.target.checked ? [...draft.rules, rule] : draft.rules.filter((value) => value !== rule) })} /> {label}</label>)}
        </fieldset>}
        {id === undefined && actions.recommend && actions.addRecommended && <details>
          <summary>{tr("Recommended folders")}</summary>
          <button className="mtg-action" type="button" disabled={busy || loadingRecommended}
            onClick={() => void loadRecommended()}>{recommended ? tr("Refresh recommendations") : tr("Show recommendations")}</button>
          {loadingRecommended && <p role="status">{tr("Loading recommended folders…")}</p>}
          {recommended?.length === 0 && <p>{tr("No recommended folders available.")}</p>}
          {!!recommended?.length && <ul>{recommended.map(({ token, title, description }) => <li key={token}>
            <strong>{title}</strong>{description && <p>{description}</p>}
            <button className="mtg-action" type="button" disabled={busy || loadingRecommended || atLimit}
              onClick={() => void addRecommended(token)}>{tr("Add ")}{title}</button>
          </li>)}</ul>}
        </details>}
        {atLimit && <p role="status">{tr("Telegram folder limit reached (")}{limit}{tr("). You can still edit existing folders.")}</p>}
        {status && <p role="status">{tr(status)}</p>}
        <button className="mtg-action" type="submit" disabled={!canSave}>{tr("Save folder")}</button>
        {conflict && id !== undefined && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => void select(id)}>{tr("Reload folder")}</button>}
        {id !== undefined && original && !confirm && <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirm(true)}>{tr("Delete folder")}</button>}
        {confirm && <>
          <p>{tr("Delete this folder and keep its chats?")}</p>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => void remove()}>{tr("Confirm folder deletion")}</button>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirm(false)}>{tr("Keep folder")}</button>
        </>}
        <button className="mtg-action" type="button" disabled={busy} onClick={() => dialog.current?.close()}>{tr("Done")}</button>
      </form>
      {actions.folderUpdates && id !== undefined && draft.shareable && <FolderUpdates key={`updates:${id}`}
        id={id} actions={actions.folderUpdates} disabled={busy} />}
      {actions.invites && id !== undefined && original && <FolderInvites key={id}
        id={id} actions={actions.invites} disabled={busy} />}
      {actions.tags && <FolderTags key={`tags:${orderSession}`} actions={actions.tags} disabled={busy} />}
      {actions.reorder && (folders.length > 1 || (folders.length === 1 && mainPosition !== undefined && actions.canMoveMain)) &&
        <FolderOrder key={orderSession} folders={folders} mainPosition={mainPosition} canMoveMain={actions.canMoveMain}
          save={actions.reorder} disabled={busy} />}
    </dialog>
  </>;
}

export function ChatFolderMemberships({ chatId, folders, actions }: { chatId: string; folders: TelegramFolder[]; actions: FolderActions }) {
  const { t: tr } = useTelegramLocale();
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
    <summary>{tr("Chat folders")}</summary>
    {error && <p role="alert">{tr("Could not read or update folders. ")}<button type="button" className="mtg-action" disabled={busy}
      onClick={() => setRevision((value) => value + 1)}>{tr("Retry")}</button></p>}
    {!rows && !error && <p role="status">{tr("Loading folders…")}</p>}
    {rows?.map(({ id, mode, shareable }) => {
      const folder = folders.find((item) => item.id === id);
      return folder && <label key={id}>{folder.title} <select value={mode} disabled={busy}
        onChange={(event) => void change(id, event.target.value as FolderMembership["mode"])}>
        <option value="automatic">{tr("Automatic")}</option>
        <option value="include">{tr("Include")}</option>
        {!shareable && <option value="exclude">{tr("Exclude")}</option>}
      </select></label>;
    })}
  </details>;
}
