import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState, type ComponentProps } from "react";
import { Clock3 } from "lucide-react";
import { ComposerActionEntry } from "./composer-actions.tsx";
import { scheduleRepeatPeriods, type ScheduledAlbumCancellation, type ScheduledMessage, type ScheduleRepeatPeriod, type SendResult, type TextDelivery } from "../core/contract.ts";

import type { LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { MessageEdit, replacePreparedPhoto, type ReplacePhoto, type ReplaceAttachment, type ReplacementProgress, type AttachmentEditResult, editableMessageText, submitMessageEdit, type EditDraft, type EditText, type EditCaption } from "./message-edit.tsx";
import { MessageText } from "./message-text.tsx";
import { MediaAlbumBody, sharedAlbumCaption } from "./message-album.tsx";
import { MessageContent } from "./message-content.tsx";
import { isSaveableAttachment, type MessageSelectionActions } from "./message-selection.tsx";
import { repeatLabel } from "./attachment-delivery.tsx";

type ScheduledMedia = Pick<ComponentProps<typeof MessageContent>, "loadPhoto" | "loadMedia" | "loadVideoStream" | "saveDocument">;

function localScheduleTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function ScheduledMessages({ chatId, topicId, loadGroupEmoji, draft, canSend, textOptions = true, send, load, checkOnline, checkRepeat, cancel, change, accepted, liveRevision, mediaLoaders, saveSelectedAttachments, editActions }: {
  chatId: string;
  loadGroupEmoji?: LoadGroupEmoji;
  topicId?: number;
  mediaLoaders?: ScheduledMedia;
  saveSelectedAttachments?: MessageSelectionActions["saveSelectedAttachments"];
  editActions?: { editText?: EditText; editCaption?: EditCaption; replacePhoto?: ReplacePhoto; replaceAttachment?: ReplaceAttachment };
  liveRevision: number;
  draft: string;
  canSend: boolean;
  textOptions?: boolean;
  send: (delivery: TextDelivery) => Promise<SendResult>;
  load: (id: string, topicId?: number) => Promise<ScheduledMessage[]>;
  checkRepeat?: () => Promise<boolean>;
  checkOnline?: (id: string) => Promise<boolean>;
  cancel: (id: string, messageId: string, topicId?: number, album?: ScheduledAlbumCancellation) => Promise<boolean>;
  change?: (id: string, row: ScheduledMessage, at: number | null, topicId?: number) => Promise<"updated" | "changed" | "unavailable">;
  accepted: (text: string, result: Extract<SendResult, { state: "sent" }>, scheduled: boolean) => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [onlineAllowed, setOnlineAllowed] = useState(false);
  const [repeatAllowed, setRepeatAllowed] = useState(false);
  const [repeatEvery, setRepeatEvery] = useState<ScheduleRepeatPeriod>();
  const [silent, setSilent] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<ScheduledMessage[]>();
  const [loadError, setLoadError] = useState(false);
  const [editTime, setEditTime] = useState<{ row: ScheduledMessage; value: string }>();
  const [editing, setEditing] = useState<{ revision: string; draft: EditDraft }>();
  const [openPreview, setOpenPreview] = useState<string>();
  const [confirm, setConfirm] = useState<{ id: string; album?: ScheduledAlbumCancellation }>();
  useEffect(() => {
    if (!open) return;
    let current = true;
    void (topicId === undefined ? load(chatId) : load(chatId, topicId)).then(
      (result) => { if (current) { setRows(result); setLoadError(false); } },
      () => { if (current) setLoadError(true); },
    );
    return () => { current = false; };
  }, [open, chatId, topicId, revision, load, liveRevision]);

  useEffect(() => {
    setOnlineAllowed(false);
    if (!open || !textOptions || !checkOnline) return;
    let active = true;
    void checkOnline(chatId).then((allowed) => {
      if (active) setOnlineAllowed(allowed);
    }, () => { if (active) setOnlineAllowed(false); });
    return () => { active = false; };
  }, [open, chatId, checkOnline, liveRevision, textOptions]);

  useEffect(() => {
    if (!open || !textOptions || !checkRepeat) return;
    let active = true;
    void checkRepeat().then((allowed) => {
      if (active) setRepeatAllowed(allowed);
    }, () => { if (active) setRepeatAllowed(false); });
    return () => { active = false; };
  }, [open, checkRepeat, textOptions]);

  async function submit(mode: "silent" | "date" | "online") {
    const schedule = mode !== "silent";
    const text = draft.trim();
    if (busy || !canSend || !text || mode === "online" && !onlineAllowed) return;
    const at = mode === "date" ? Math.floor(new Date(when).getTime() / 1000) : undefined;
    if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10)) {
      setStatus("Choose a date and time in the future.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await send({ silent: schedule ? silent : true, ...(at === undefined ? {} : { at }),
        ...(mode === "online" ? { whenOnline: true } : {}),
        ...(mode === "date" && repeatAllowed && repeatEvery ? { repeatEvery } : {}) });
      if (result.state !== "sent") {
        setStatus(result.state === "failed" ? "Telegram rejected the message. Your draft is still here."
          : "Delivery unconfirmed. Check the chat and scheduled messages before retrying.");
        return;
      }
      accepted(text, result, schedule);
      if (schedule) {
        setWhen("");
        setRepeatEvery(undefined);
        setRevision((value) => value + 1);
      }
      setStatus(schedule ? "Scheduled." : "Sent silently.");
    } catch {
      setStatus("Delivery unconfirmed. Check Telegram before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function updateSchedule(row: ScheduledMessage, at: number | null) {
    if (!change || busy) return;
    if (at !== null && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) {
      setStatus("Choose a supported date and time in the future.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await (topicId === undefined ? change(chatId, row, at) : change(chatId, row, at, topicId));
      if (result === "updated") {
        if (at === null || row.albumId) setRows(undefined);
        else setRows((previous) => previous?.map((item) => {
            if (item.id !== row.id) return item;
            const { whenOnline: _whenOnline, ...eligible } = item;
            return { ...eligible, at };
          }));
        setEditTime(undefined);
        setStatus(at === null ? "Telegram released the message for sending." : "Schedule updated.");
      } else {
        if (result === "changed") setEditTime(undefined);
        setStatus(result === "changed" ? "The scheduled message changed in Telegram." : "Telegram could not update the schedule.");
      }
    } catch {
      setStatus("Telegram did not confirm the change. Check the schedule before retrying.");
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  const saveEdit: ComponentProps<typeof MessageEdit>["save"] = async (event, styles, removeLinkPreview, placement, links, customEmoji) => {
    event.preventDefault();
    if (!editing || !editActions || busy) return;
    const { draft, revision } = editing;
    await applyEdit(editing, () => submitMessageEdit(chatId, draft.message, draft.text.trim(), editActions, styles,
      removeLinkPreview, placement, links, { revision, ...(topicId === undefined ? {} : { topicId }) }, customEmoji));
  };

  async function replaceEditedPhoto(file: File) {
    const replace = editActions?.replacePhoto;
    if (!editing || !replace || busy) return;
    const { draft, revision } = editing;
    await applyEdit(editing, () => replacePreparedPhoto(replace, chatId, draft.message, file,
      { revision, ...(topicId === undefined ? {} : { topicId }) }));
  }

  async function replaceEditedAttachment(file: File, progress: ReplacementProgress, signal: AbortSignal) {
    const replace = editActions?.replaceAttachment;
    const attachment = editing?.draft.message.attachmentEdit;
    if (!editing || !replace || !attachment || busy) return;
    await applyEdit(editing, () => replace(chatId, editing.draft.message.id, attachment, file, progress, signal,
      { revision: editing.revision, ...(topicId === undefined ? {} : { topicId }) }));
  }

  async function applyEdit(currentEdit: NonNullable<typeof editing>, perform: () => Promise<AttachmentEditResult> | undefined) {
    const { draft, revision } = currentEdit;
    setBusy(true);
    setEditing({ revision, draft: { ...draft, busy: true, error: undefined } });
    setStatus("");
    try {
      const result = await perform();
      if (result?.state === "sent") {
        setEditing(undefined);
        setStatus("Scheduled message updated.");
      } else {
        setEditing({ revision, draft: { ...draft, busy: false, error: result?.state === "cancelled" ? undefined : result?.state === "unknown"
          ? "Telegram did not confirm the edit. Check the queue before retrying."
          : "The scheduled message changed or Telegram rejected the edit. Reopen it to review." } });
      }
    } catch {
      setEditing({ revision, draft: { ...draft, busy: false, error: "Could not verify the scheduled edit. Check the queue before retrying." } });
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  async function remove({ id, album }: { id: string; album?: ScheduledAlbumCancellation }) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const cancelled = await (album ? cancel(chatId, id, topicId, album)
        : topicId === undefined ? cancel(chatId, id) : cancel(chatId, id, topicId));
      if (cancelled) {
        setRows((previous) => previous?.filter((row) => album ? !album.members.includes(row.id) : row.id !== id));
        setStatus(album ? "Scheduled album cancelled." : "Scheduled message cancelled.");
      } else setStatus(album ? "The album could not be cancelled. Check the refreshed queue." : "This message could not be cancelled.");
    } catch {
      setStatus("Could not confirm cancellation.");
    } finally {
      setConfirm(undefined);
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  async function downloadAlbum(ids: string[]) {
    if (!saveSelectedAttachments || busy) return;
    setBusy(true);
    setStatus("");
    try {
      setStatus(await saveSelectedAttachments(chatId, ids) ? "Attachment archive download started." : "Could not start the attachment archive.");
    } catch { setStatus("Could not start the attachment archive."); }
    finally { setBusy(false); }
  }

  const groups = new Map<string, ScheduledMessage[]>();
  for (const row of rows ?? []) {
    const key = row.albumId ? `album:${row.albumId}` : `message:${row.id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return <div className="mtg-composer-media">
    <div><ComposerActionEntry inline={open}><button type="button" className="mtg-action" aria-expanded={open} disabled={busy} onClick={() => {
      setOpen(!open);
      setOpenPreview(undefined);
      setConfirm(undefined);
      setEditTime(undefined);
    }}><Clock3 size={16} aria-hidden="true" /> {textOptions ? tr("Send options") : tr("Scheduled messages")}</button></ComposerActionEntry></div>
    {open && <>
      {textOptions && <div className="mtg-composer-media-buttons">
        <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim()} onClick={() => void submit("silent")}>{tr("Send silently")}</button>
        {onlineAllowed && <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim()}
          onClick={() => void submit("online")}>{tr("Send when online")}</button>}
        <label>{tr("Send at ")}<input type="datetime-local" value={when} disabled={busy} onInput={(event) => setWhen(event.currentTarget.value)} /></label>
        {repeatAllowed && <label>{tr("Repeat ")}<select value={repeatEvery ?? ""} disabled={busy}
          onChange={(event) => setRepeatEvery(scheduleRepeatPeriods.find((seconds) => seconds === Number(event.target.value)))}>
          <option value="">{tr("Never")}</option>
          {scheduleRepeatPeriods.map((seconds) => <option key={seconds} value={seconds}>{repeatLabel(seconds)}</option>)}
        </select></label>}
        <label><input type="checkbox" checked={silent} disabled={busy} onChange={(event) => setSilent(event.target.checked)} />{tr(" Silent")}</label>
        <button type="button" className="mtg-action" disabled={busy || !canSend || !draft.trim() || !when} onClick={() => void submit("date")}>{tr("Schedule message")}</button>
      </div>}
      {editing && <section aria-label={tr("Edit scheduled message")}>
        <MessageEdit draft={editing.draft} save={saveEdit} cancel={() => setEditing(undefined)}
          groupEmoji={loadGroupEmoji ? { id: chatId, load: loadGroupEmoji } : undefined}
          replacePhoto={editActions?.replacePhoto && editing.draft.message.photoEditRevision ? replaceEditedPhoto : undefined}
          replaceAttachment={editActions?.replaceAttachment && editing.draft.message.attachmentEdit ? replaceEditedAttachment : undefined}
          change={(text) => setEditing({ ...editing, draft: { ...editing.draft, text } })} />
      </section>}
      {loadError ? <p role="alert">{tr("Could not load scheduled messages. ")}<button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>{tr("Retry")}</button></p>
        : rows?.length ? <ul className="mtg-scheduled-list" aria-label={tr("Scheduled messages")}>{Array.from(groups, ([key, group]) => {
          group.sort((a, b) => Number(a.id) - Number(b.id));
          const row = group.find(({ media }) => media?.photoCaption || media?.document?.caption) ?? group[0]!;
          const albumId = row.albumId;
          const album = !!albumId;
          const preview = openPreview === key;
          const media = group.flatMap((item) => item.media ? [item.media] : []);
          const fullAlbum = album && media.length === group.length && media.length > 1;
          const albumCaption = fullAlbum ? sharedAlbumCaption(media) : undefined;
          const attachmentCaption = row.media?.photoCaption ?? row.media?.document?.caption;
          const summary = attachmentCaption && row.media
            ? <MessageText text={attachmentCaption} styles={row.media.styles} links={row.media.links} customEmoji={row.media.customEmoji} />
            : <MessageText text={row.text} styles={row.styles} links={row.links} customEmoji={row.customEmoji} />;
          const attachmentIds = preview && album && saveSelectedAttachments
            ? group.filter(({ media }) => media && isSaveableAttachment(media)).map(({ id }) => id) : [];
          return <li key={key}>
            <span>{row.whenOnline ? tr("When online") : row.at === undefined ? tr("Scheduled") : new Date(row.at * 1000).toLocaleString(uiLocale)}</span>
            {row.repeatEvery && <p>{repeatLabel(row.repeatEvery)}</p>}
            {album && <p>{tr("Album · ")}{group.length}{tr(" items")}</p>}
            {mediaLoaders && media.length > 0 ? <>
              <button type="button" className="mtg-action" aria-expanded={preview}
                onClick={() => setOpenPreview(preview ? undefined : key)}>
                {preview ? tr("Hide media preview") : album ? tr("Preview scheduled album") : tr("Preview scheduled media")}
              </button>
              {preview && fullAlbum ? <MediaAlbumBody caption={albumCaption}>
                {media.map((message) => <li key={message.id}>
                  <MessageContent chatId={chatId} message={message} hideCaption={albumCaption?.message === message} {...mediaLoaders} />
                </li>)}
              </MediaAlbumBody> : preview ? group.map((item) => item.media
                ? <MessageContent key={item.id} chatId={chatId} message={item.media} {...mediaLoaders} />
                : <MessageText key={item.id} text={item.text} styles={item.styles} links={item.links} customEmoji={item.customEmoji} />)
                : summary}
              {attachmentIds.length > 1 && <button type="button" className="mtg-action" disabled={busy}
                onClick={() => void downloadAlbum(attachmentIds)}>{tr("Save scheduled album attachments")}</button>}
            </> : summary}
            {!editing && (confirm && group.some((item) => item.id === confirm.id) ? <>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void remove(confirm)}>{confirm.album ? tr("Confirm album cancellation") : tr("Confirm cancellation")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>{tr("Keep message")}</button>
            </> : editTime?.row.id === row.id ? <>
              <label>{tr("New send time ")}<input type="datetime-local" value={editTime.value} disabled={busy}
                onInput={(event) => setEditTime({ row: editTime.row, value: event.currentTarget.value })} /></label>
              <button type="button" className="mtg-action" disabled={busy || !editTime.value}
                onClick={() => void updateSchedule(editTime.row, Math.floor(new Date(editTime.value).getTime() / 1000))}>{tr("Save new send time")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setEditTime(undefined)}>{tr("Keep current time")}</button>
            </> : <>
              {row.revision && row.editable && (row.editable.editableCaption ? editActions?.editCaption : editActions?.editText)
                && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
                  if (!row.revision || !row.editable) return;
                  setEditing({ revision: row.revision, draft: { message: row.editable, text: editableMessageText(row.editable), busy: false } });
                  setEditTime(undefined);
                  setConfirm(undefined);
                }}>{row.editable.editableCaption ? tr("Edit scheduled caption") : tr("Edit scheduled text")}</button>}
              {change && <button type="button" className="mtg-action" disabled={busy}
                title={tr("Telegram also sends messages forwarded together with this one")} onClick={() => void updateSchedule(row, null)}>
                {row.albumId ? tr("Send album now") : tr("Send now")}
              </button>}
              {change && (row.at !== undefined || row.whenOnline) && <button type="button" className="mtg-action" disabled={busy}
                title={tr("Telegram also reschedules messages scheduled together with this one")} onClick={() => {
                  setConfirm(undefined);
                  setEditTime({ row, value: row.at === undefined ? "" : localScheduleTime(row.at) });
                }}>{album ? tr("Reschedule album") : tr("Reschedule")}</button>}
              {albumId && group.length > 1 && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
                setEditTime(undefined);
                setConfirm({ id: row.id, album: { id: albumId, members: group.map((item) => item.id) } });
              }}>{tr("Cancel scheduled album")}</button>}
              {album ? <details>
                <summary>{tr("Cancel an album item")}</summary>
                {group.map((item, index) => <button key={item.id} type="button" className="mtg-action" disabled={busy}
                  onClick={() => { setEditTime(undefined); setConfirm({ id: item.id }); }}>{tr("Cancel item ")}{index + 1}</button>)}
              </details> : <button type="button" className="mtg-action" disabled={busy} onClick={() => {
                setEditTime(undefined);
                setConfirm({ id: row.id });
              }}>{tr("Cancel scheduled message")}</button>}
            </>)}
          </li>;
        })}</ul> : <p>{rows ? tr("No scheduled messages.") : tr("Loading scheduled messages…")}</p>}
      {status && <p role="status">{tr(status)}</p>}
    </>}
  </div>;
}
