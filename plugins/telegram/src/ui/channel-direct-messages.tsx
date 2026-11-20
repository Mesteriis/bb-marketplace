import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { channelInboxSearchFilter, type ChannelInboxBan, type ChannelInboxSearchFilter, type ChannelInboxTopic, type ChannelInboxTopics, type ClearChatDateRange, type ClearChatDateResult, type ContextDirection, type HistoryPage, type MessageSearchDateRange, type MessageSearchFilter, type MessageSearchPage, type MessageSender, type SendResult } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";
import { ClearChatHistoryByDate } from "./clear-chat-history-by-date.tsx";
import { ConversationSearch } from "./conversation-search.tsx";
import { HistoryMessageUpdates, type HistoryMessageUpdateActions } from "./history-message-updates.ts";
import { sendSplitDraft } from "../core/split-draft.ts";
import { isFindShortcut, isPanelShortcut, isPlainKey } from "./composer-keys.ts";
import type { ChannelInboxMessageEvent, MessagesDeleted } from "../core/contract.ts";
import { captureHistoryScroll, historyWheelDirection, restoreHistoryScroll } from "./history-scroll.ts";
import { readableHistoryIds, useVisibleHistoryRead, type MarkHistoryRead } from "./visible-history-read.ts";
import type { ChannelInboxReadState, ChannelInboxReply, InboxCaptionEdit, InboxTextEdit } from "../core/contract.ts";
import { SelectReplyQuote } from "./select-reply-quote.tsx";
import { selectedReplyQuote } from "./selected-reply-quote.ts";
import { MessageContent } from "./message-content.tsx";
import { RunRichBotCommand } from "./rich-message.tsx";
import { DraftFormatButton, DraftFormatControls, draftFormattingShortcuts, draftLinkShortcuts, useDraftFormatting } from "./draft-formatting.tsx";
import { createInboxDrafts, textDraftAttachment, useDraftRecord, type DraftFormatting, type DraftRecord, type InboxDraft } from "./local-drafts.ts";
import type { ForwardActions } from "./message-forward.tsx";
import { useMessageSelection, type MessageSelectionActions } from "./message-selection.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { editableMessageText, MessageEdit, submitMessageEdit, type EditCaption, type EditDraft, type EditText } from "./message-edit.tsx";
import { MessagePin, type BulkUnpinActions, type MessagePinActions } from "./message-pin.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { ChannelInboxNote, type InboxNoteRecording } from "./channel-inbox-note.tsx";
import { ChannelInboxMediaPicker, type InboxMediaPicker } from "./channel-inbox-media-picker.tsx";
import type { ReactionActions } from "./message-reactions.tsx";
import { OpenReactionPerson } from "./reaction-people.tsx";
import { MessageAlbum, sharedAlbumCaption } from "./message-album.tsx";
import { groupMessageTimeline } from "../core/message-timeline.ts";
import { isAudioAttachmentName, isGifAttachmentName, isVideoAttachmentName, maxOriginalPhotoBytes, maxTelegramTextLength, maxTelegramUploadBytes,
  type ChannelInboxAlbumUpload, type ChannelInboxAttachmentKind, type DocumentSender, type VoiceRecording,
  type VideoNoteRecording, type MediaChoiceSelection, type ChannelInboxMessageReference, type SelectableReaction,
  type ReactionPersonReference, type ReactionPeoplePage, type ForwardAlbum, type ForwardTarget,
  type ForwardPresentation, type ForwardDelivery, type ForwardResult, type ChannelInboxMessageBatch,
  type ChannelInboxSelection, type SelectedText, type CaptionFormat } from "../core/contract.ts";
import { isPhotoMimeType } from "./prepare-photo.ts";

export type ChannelDirectMessagesLoader = (id: string) => Promise<Chat | null>;
type InboxMedia = Pick<ComponentProps<typeof ConversationSearch>, "loadPhoto" | "loadMedia" | "loadVideoStream" | "transcribeVoice" | "saveDocument" | "mediaCollection" | "loadAvatar">;
type OpenInboxReactionProfile = (target: ReactionPersonReference, signal: AbortSignal, load: () => Promise<Chat | null>) => Promise<boolean>;
type ForwardRecipients = Pick<ForwardActions, "recipients" | "searchRecipients" | "folders" | "communities" | "loadTopics" | "loadMessageEffects"
  | "canScheduleWhenOnline" | "canScheduleRepeats">;
export type ChannelInboxActions = {
  runRichBotCommand?: (channelId: string, inboxId: string, topicId: string, messageId: string, command: string) => Promise<SendResult>;
  loadTopics: (channelId: string, inboxId: string, offset: number) => Promise<ChannelInboxTopics>;
  loadTopicsSnapshot?: (channelId: string, inboxId: string, count: number, selected?: string) =>
    Promise<ChannelInboxTopics & { selected?: ChannelInboxReadState }>;
  subscribeToTopics?: (listener: (inboxId: string) => void) => () => void;
  loadHistory: (channelId: string, inboxId: string, topicId: string, before?: string, after?: string) => Promise<HistoryPage>;
  loadMessage?: (channelId: string, inboxId: string, topicId: string, messageId: string) => Promise<Message | null>;
  editText?: (channelId: string, inboxId: string, topicId: string, edit: InboxTextEdit) => Promise<SendResult>;
  editCaption?: (channelId: string, inboxId: string, topicId: string, edit: InboxCaptionEdit) => Promise<SendResult>;
  subscribeToMessages?: (listener: (event: ChannelInboxMessageEvent) => void) => () => void;
  subscribeToDeletions?: (listener: (event: MessagesDeleted) => void) => () => void;
  search?: (channelId: string, inboxId: string, topicId: string, query: string, before?: string, range?: MessageSearchDateRange,
    filter?: ChannelInboxSearchFilter) => Promise<MessageSearchPage>;
  messageAtDate?: (channelId: string, inboxId: string, topicId: string, date: number) => Promise<string | null>;
  loadMessageContext?: (channelId: string, inboxId: string, topicId: string, messageId: string, direction?: ContextDirection) => Promise<Message[]>;
  mark?: (channelId: string, inboxId: string, topicId: string, unread: boolean) =>
    Promise<ChannelInboxReadState | null>;
  markVisible?: (channelId: string, inboxId: string, topicId: string, messageId: string, clearUnreadMark?: true) =>
    Promise<ChannelInboxReadState | null>;
  loadBan?: (channelId: string, inboxId: string, topicId: string) => Promise<ChannelInboxBan | null>;
  changeBan?: (channelId: string, inboxId: string, topicId: string, expected: ChannelInboxBan) =>
    Promise<"updated" | "changed" | "unavailable" | "unknown">;
  clearByDate?: (channelId: string, inboxId: string, topicId: string, range: ClearChatDateRange) => Promise<ClearChatDateResult>;
  clearConversation?: (channelId: string, inboxId: string, topicId: string) => Promise<"deleted" | "refused" | "unknown">;
  messageDeletable?: (channelId: string, inboxId: string, topicId: string, messageId: string) => Promise<boolean>;
  messagePinStatus?: (channelId: string, inboxId: string, topicId: string, messageId: string) => Promise<boolean | null>;
  setMessagePinned?: (channelId: string, inboxId: string, topicId: string, messageId: string, pinned: boolean) =>
    ReturnType<MessagePinActions["setMessagePinned"]>;
  bulkUnpinPreview?: (channelId: string, inboxId: string, topicId: string) => Promise<string | null>;
  bulkUnpin?: (channelId: string, inboxId: string, topicId: string, messageId: string) => ReturnType<BulkUnpinActions["unpin"]>;
  deleteMessage?: (channelId: string, inboxId: string, topicId: string, messageId: string) => ReturnType<MessageDeletionActions["deleteMessage"]>;
  deleteSelection?: {
    available: (scope: ChannelInboxMessageBatch) => Promise<boolean>;
    remove: (scope: ChannelInboxMessageBatch) => ReturnType<MessageDeletionActions["deleteMessage"]>;
  };
  sendText?: (channelId: string, inboxId: string, topicId: string, text: string, replyTo?: ChannelInboxReply, format?: CaptionFormat) => Promise<SendResult>;
  sendFile?: (channelId: string, inboxId: string, topicId: string, file: File, caption: string, replyTo: ChannelInboxReply | undefined,
    progress: Parameters<DocumentSender>[3], signal: AbortSignal, kind?: ChannelInboxAttachmentKind, format?: CaptionFormat) => ReturnType<DocumentSender>;
  sendAlbum?: (channelId: string, inboxId: string, topicId: string, items: InboxAlbumItem[], caption: string, replyTo: ChannelInboxReply | undefined,
    progress: Parameters<DocumentSender>[3], signal: AbortSignal, format?: CaptionFormat) => ReturnType<DocumentSender>;
  sendVoice?: (channelId: string, inboxId: string, topicId: string, recording: VoiceRecording, replyTo?: ChannelInboxReply) => Promise<SendResult>;
  sendVideoNote?: (channelId: string, inboxId: string, topicId: string, recording: VideoNoteRecording, replyTo?: ChannelInboxReply) => Promise<SendResult>;
  mediaPicker?: InboxMediaPicker;
  copySelectedText?: (scope: ChannelInboxSelection, format?: "portable") => Promise<SelectedText | null>;
  saveSelectedAttachments?: (scope: ChannelInboxSelection, format?: "html") => Promise<boolean>;
  forwarding?: {
    options: (scope: ChannelInboxMessageReference, album?: ForwardAlbum) => Promise<boolean>;
    send: (scope: ChannelInboxMessageReference, target: ForwardTarget, album?: ForwardAlbum, presentation?: ForwardPresentation,
      delivery?: ForwardDelivery, comment?: string) => Promise<ForwardResult>;
    selection?: {
      options: (scope: ChannelInboxMessageBatch) => Promise<boolean>;
      send: (scope: ChannelInboxMessageBatch, target: ForwardTarget, presentation?: ForwardPresentation,
        delivery?: ForwardDelivery, comment?: string) => Promise<ForwardResult>;
    };
  };
  reactions?: {
    list: (scope: ChannelInboxMessageReference) => Promise<SelectableReaction[]>;
    set: (scope: ChannelInboxMessageReference, reaction: SelectableReaction, chosen: boolean) => Promise<boolean>;
    people: (scope: ChannelInboxMessageReference, reaction: SelectableReaction | undefined, offset: string) => Promise<ReactionPeoplePage | null>;
    person: (scope: ChannelInboxMessageReference, target: ReactionPersonReference) => Promise<Chat | null>;
  };
};
type InboxAlbumItem = { kind: ChannelInboxAlbumUpload["items"][number]["kind"]; file: File };
const emptyInboxDraft: InboxDraft = { text: "" };

const inboxMediaLabels = { photo: "Photo", video: "Video", audio: "Audio", animation: "GIF" };
function inboxMediaKind(file: File): Exclude<ChannelInboxAttachmentKind, "document"> | undefined {
  if (isPhotoMimeType(file.type) && file.size <= maxOriginalPhotoBytes) return "photo";
  if (isVideoAttachmentName(file.name)) return "video";
  if (isAudioAttachmentName(file.name)) return "audio";
  if (isGifAttachmentName(file.name)) return "animation";
}

function inboxAlbumItems(files: File[]) {
  const kinds = files.map(inboxMediaKind);
  if (kinds.every((kind) => kind === "photo" || kind === "video")) {
    return files.map((file, index): InboxAlbumItem => ({ kind: kinds[index] === "photo" ? "photo" : "video", file }));
  }
  if (kinds.every((kind) => kind === "audio")) return files.map((file): InboxAlbumItem => ({ kind: "audio", file }));
}

export function ChannelDirectMessages({ id, channelName, load, open, inboxActions, inboxMedia, forwardRecipients, openReactionProfile, draftStorage }: {
  id: string;
  channelName: string;
  load: ChannelDirectMessagesLoader;
  open: (chat: Chat) => void;
  inboxActions?: ChannelInboxActions;
  inboxMedia?: InboxMedia;
  forwardRecipients?: ForwardRecipients;
  openReactionProfile?: OpenInboxReactionProfile;
  draftStorage?: (inboxId: string) => ReturnType<typeof createInboxDrafts>;
}) {
  const { t: tr } = useTelegramLocale();
  const [chat, setChat] = useState<Chat | null>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inbox, setInbox] = useState<Chat>();
  const inboxOpener = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(false);
    void load(id).then((result) => {
      if (!controller.signal.aborted) setChat(result);
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      request.current?.abort();
      request.current = undefined;
    };
  }, [id, load]);
  async function select() {
    if (request.current || !chat) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    const current = await load(id).catch(() => null);
    if (controller.signal.aborted) return;
    request.current = undefined;
    setBusy(false);
    if (current?.id === chat.id && current.subtitle === chat.subtitle) {
      if (current.subtitle === "Channel inbox") setInbox(current);
      else open(current);
    }
    else setFailed(true);
  }
  if (!chat) return failed ? <p role="status">{tr("Could not check channel direct messages.")}</p> : null;
  const isInbox = chat.subtitle === "Channel inbox";
  if (isInbox && !inboxActions) return null;
  if (inbox && inboxActions) return <ChannelInbox channelId={id} channelName={channelName} inboxId={inbox.id}
    draftStorage={draftStorage?.(inbox.id)}
    actions={inboxActions} media={inboxMedia} forwardRecipients={forwardRecipients}
    openReactionProfile={openReactionProfile} close={() => {
      setInbox(undefined);
      requestAnimationFrame(() => inboxOpener.current?.focus({ preventScroll: true }));
    }} />;
  return <div>
    <button ref={inboxOpener} type="button" className="mtg-action" disabled={busy} onClick={() => void select()}>{isInbox ? tr("Open channel inbox") : tr("Message channel")}</button>
    {failed && <p role="status">{tr("Channel direct messages changed or are unavailable.")}</p>}
  </div>;
}

function ChannelInbox({ channelId, channelName, inboxId, actions, media, forwardRecipients, openReactionProfile, close, draftStorage }: {
  channelId: string; channelName: string; inboxId: string; actions: ChannelInboxActions; media?: InboxMedia;
  forwardRecipients?: ForwardRecipients;
  openReactionProfile?: OpenInboxReactionProfile; close: () => void;
  draftStorage?: ReturnType<typeof createInboxDrafts>;
}) {
  const { t: tr } = useTelegramLocale();
  const [topics, setTopics] = useState<ChannelInboxTopic[]>([]);
  const [request, setRequest] = useState({ offset: 0 });
  const [next, setNext] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  const [selected, setSelected] = useState<ChannelInboxTopic>();
  const conversationList = useRef<HTMLUListElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [localDraftStorage] = useState(createInboxDrafts);
  const { drafts: draftRecord, formatting: draftFormatting, sending: sendingRecord } = draftStorage ?? localDraftStorage;
  const [drafts, setDrafts] = useDraftRecord(draftRecord);
  const [sending] = useDraftRecord(sendingRecord);
  const marking = useRef(false);
  const [markingTopic, setMarkingTopic] = useState<string>();
  const [markError, setMarkError] = useState<string>();
  const [clearedTopic, setClearedTopic] = useState<string>();
  const [topicRevision, setTopicRevision] = useState(0);
  const refreshedRevision = useRef(0);
  const selectedId = selected?.id;
  const updateReadState = useCallback((id: string, read: ChannelInboxReadState) => {
    setTopics((previous) => previous.map((row) => row.id === id && (read.readInbox ?? 0) >= (row.readInbox ?? 0)
      ? { ...row, ...read } : row));
    setSelected((row) => row?.id === id && (read.readInbox ?? 0) >= (row.readInbox ?? 0) ? { ...row, ...read } : row);
  }, []);
  const clearDeletedReply = useCallback((ids: ReadonlySet<string>) => {
    if (!selectedId) return;
    setDrafts((previous) => {
      const draft = previous[selectedId];
      const reply = draft?.replyTo;
      const id = typeof reply === "string" ? reply : reply?.messageId;
      return id && ids.has(id) ? { ...previous, [selectedId]: { ...draft, replyTo: undefined } } : previous;
    });
  }, [selectedId]);
  const { loadTopics, loadHistory, loadTopicsSnapshot, subscribeToTopics } = actions;
  useEffect(() => {
    let active = true;
    void loadTopics(channelId, inboxId, request.offset).then((page) => {
      if (!active) return;
      setTopics((previous) => [...new Map([...(request.offset ? previous : []), ...page.topics]
        .map((topic) => [topic.id, topic])).values()]);
      setNext(page.next);
      setStatus("ready");
    }, () => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [channelId, inboxId, loadTopics, request]);
  useEffect(() => {
    if (!subscribeToTopics) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToTopics((id) => {
      if (id !== inboxId || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setTopicRevision((revision) => revision + 1);
      }, 150);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [inboxId, subscribeToTopics]);
  const loadedCount = Math.max(30, topics.length);
  useEffect(() => {
    if (!loadTopicsSnapshot || status !== "ready" || refreshedRevision.current === topicRevision) return;
    let active = true;
    void loadTopicsSnapshot(channelId, inboxId, loadedCount, selectedId).then((page) => {
      if (!active) return;
      refreshedRevision.current = topicRevision;
      setTopics((previous) => {
        const known = new Map(previous.map((row) => [row.id, row]));
        return page.topics.map((row) => {
          const current = known.get(row.id);
          return current && (current.readInbox ?? 0) > (row.readInbox ?? 0) ? { ...current, name: row.name } : row;
        });
      });
      if (selectedId && page.selected) {
        const read = page.selected;
        setSelected((row) => row?.id === selectedId && (read.readInbox ?? 0) >= (row.readInbox ?? 0) ? { ...row, ...read } : row);
      }
      setNext(page.next);
    }, () => { /* The current list and manual refresh stay available. */ });
    return () => { active = false; };
  }, [channelId, inboxId, loadedCount, loadTopicsSnapshot, selectedId, status, topicRevision]);
  function load(offset: number) {
    setStatus("loading");
    setRequest({ offset });
  }
  async function mark(topic: ChannelInboxTopic, unread: boolean) {
    if (!actions.mark || marking.current || status !== "ready") return;
    marking.current = true;
    setMarkingTopic(topic.id);
    setMarkError(undefined);
    try {
      const result = await actions.mark(channelId, inboxId, topic.id, unread).catch(() => null);
      if (!result) setMarkError(tr("Could not update read state for {0}.", [topic.name]));
      else updateReadState(topic.id, result);
    } finally {
      marking.current = false;
      setMarkingTopic(undefined);
    }
  }
  return <section className="mtg-channel-inbox" aria-label={tr("Channel inbox")} onKeyDown={(event) => {
    if (selected || !inboxEscape(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <header><h2>{tr("Channel inbox")}</h2><button ref={closeButton} autoFocus type="button" className="mtg-action" onClick={close}>{tr("Close inbox")}</button></header>
    {clearedTopic && <p role="status">{tr("Telegram cleared the conversation with ")}<bdi>{clearedTopic}</bdi>.</p>}
    {selected ? <RunRichBotCommand.Provider value={actions.runRichBotCommand
      ? (chatId, messageId, command) => chatId === inboxId
        ? actions.runRichBotCommand!(channelId, inboxId, selected.id, messageId, command)
        : Promise.resolve({ state: "failed" })
      : undefined}><ChannelInboxThread key={selected.id} channelId={channelId} inboxId={inboxId}
      topic={topics.find(({ id }) => id === selected.id) ?? selected} load={loadHistory} send={actions.sendText} clearByDate={actions.clearByDate}
      sendFile={actions.sendFile} sendAlbum={actions.sendAlbum} sendVoice={actions.sendVoice} sendVideoNote={actions.sendVideoNote}
      mediaPicker={actions.mediaPicker} reactions={actions.reactions} openReactionProfile={openReactionProfile}
      forwarding={actions.forwarding} forwardRecipients={forwardRecipients}
      copyText={actions.copySelectedText}
      saveAttachments={actions.saveSelectedAttachments}
      markVisible={actions.markVisible} updateReadState={updateReadState}
      loadMessage={actions.loadMessage} subscribeToMessages={actions.subscribeToMessages}
      editText={actions.editText} editCaption={actions.editCaption}
      subscribeToDeletions={actions.subscribeToDeletions}
      search={actions.search} messageAtDate={actions.messageAtDate} loadMessageContext={actions.loadMessageContext}
      media={media}
      clearConversation={actions.clearConversation} conversationCleared={() => {
        setClearedTopic(selected.name);
        setSelected(undefined);
        load(0);
      }}
      draft={drafts[selected.id] ?? emptyInboxDraft}
      sending={sending[selected.id] === true}
      beginSend={() => {
        if (sendingRecord.getSnapshot()[selected.id]) return undefined;
        sendingRecord.update((previous) => ({ ...previous, [selected.id]: true }));
        return () => sendingRecord.update((previous) => ({ ...previous, [selected.id]: undefined }));
      }}
      draftFormatting={draftFormatting}
      changeDraft={(draft, expected) => {
        if (expected && (draftRecord.getSnapshot()[selected.id] ?? emptyInboxDraft) !== expected) return false;
        setDrafts((previous) => ({ ...previous, [selected.id]: draft }));
        return true;
      }}
      messageDeletable={actions.messageDeletable} deleteMessage={actions.deleteMessage}
      deleteSelection={actions.deleteSelection}
      messagePinStatus={actions.messagePinStatus} setMessagePinned={actions.setMessagePinned}
      bulkUnpinPreview={actions.bulkUnpinPreview} bulkUnpin={actions.bulkUnpin}
      clearDeletedReply={clearDeletedReply}
      moderation={actions.loadBan && actions.changeBan && <ChannelInboxModeration
        channelName={channelName} load={() => actions.loadBan!(channelId, inboxId, selected.id)}
        change={(expected) => actions.changeBan!(channelId, inboxId, selected.id, expected)} />}
      back={() => {
        setSelected(undefined);
        requestAnimationFrame(() => {
          const button = Array.from(conversationList.current?.querySelectorAll<HTMLButtonElement>("[data-inbox-topic]") ?? [])
            .find(({ dataset }) => dataset.inboxTopic === selected.id);
          (button ?? closeButton.current)?.focus({ preventScroll: true });
        });
      }} />
    </RunRichBotCommand.Provider> : <div>
        <ul ref={conversationList} aria-label={tr("Channel inbox conversations")}>
          {topics.map((topic) => {
            const unread = topic.unread > 0 || topic.markedUnread;
            return <li key={topic.id} className="mtg-channel-inbox-topic">
              <button type="button" className="mtg-action" data-inbox-topic={topic.id} onClick={() => {
                setClearedTopic(undefined);
                setSelected(topic);
              }}>
                <bdi>{topic.name}</bdi>{topic.unread > 0 ? tr(" · {0} unread", [topic.unread]) : topic.markedUnread ? tr(" · Marked unread") : ""}
              </button>
              {actions.mark && <button type="button" className="mtg-action"
                aria-disabled={!!markingTopic || status !== "ready"}
                aria-label={tr("Mark {0} as {1}", [topic.name, unread ? "read" : "unread"])}
                onClick={() => void mark(topic, !unread)}>{unread ? tr("Mark read") : tr("Mark unread")}</button>}
            </li>;
          })}
        </ul>
        {markingTopic && <p role="status">{tr("Updating inbox read state…")}</p>}
        {markError && <p role="alert">{tr(markError)}</p>}
        {status === "loading" && <p role="status">{tr("Loading inbox conversations…")}</p>}
        {status === "failed" && <p role="alert">{tr("Could not load inbox conversations. ")}<button type="button" className="mtg-action"
          onClick={() => load(request.offset)}>{tr("Retry")}</button></p>}
        {status === "ready" && topics.length === 0 && next === null && <p>{tr("No inbox conversations")}</p>}
        {status === "ready" && next !== null && <button type="button" className="mtg-action" disabled={!!markingTopic} onClick={() => load(next)}>{tr("Load more conversations")}</button>}
        {status !== "loading" && <button type="button" className="mtg-action" disabled={!!markingTopic} onClick={() => load(0)}>{tr("Refresh inbox")}</button>}
      </div>}
  </section>;
}

function inboxEscape(event: KeyboardEvent<HTMLElement>) {
  const { target, currentTarget } = event;
  const dialog = "dialog, [role=dialog]";
  return isPlainKey(event, "Escape") && target instanceof HTMLElement && currentTarget.contains(target)
    && target.closest(dialog) === currentTarget.closest(dialog)
    && !target.closest("select, [contenteditable]");
}

function ChannelInboxThread({ channelId, inboxId, topic, load, loadMessage, editText, editCaption, subscribeToMessages, subscribeToDeletions, markVisible, updateReadState,
  search, messageAtDate, loadMessageContext, media, send, sendFile, sendAlbum, sendVoice, sendVideoNote, mediaPicker, reactions,
  forwarding, forwardRecipients, copyText, saveAttachments,
  openReactionProfile, clearByDate, clearConversation, conversationCleared,
  draft, draftFormatting, changeDraft, sending, beginSend, messageDeletable, deleteMessage, deleteSelection, clearDeletedReply, messagePinStatus, setMessagePinned, bulkUnpinPreview, bulkUnpin, moderation, back }: {
  channelId: string; inboxId: string; topic: ChannelInboxTopic; load: ChannelInboxActions["loadHistory"];
  loadMessage?: ChannelInboxActions["loadMessage"];
  editText?: ChannelInboxActions["editText"];
  editCaption?: ChannelInboxActions["editCaption"];
  subscribeToMessages?: ChannelInboxActions["subscribeToMessages"];
  subscribeToDeletions?: ChannelInboxActions["subscribeToDeletions"];
  markVisible?: ChannelInboxActions["markVisible"];
  updateReadState: (id: string, read: ChannelInboxReadState) => void;
  search?: ChannelInboxActions["search"];
  media?: InboxMedia;
  messageAtDate?: ChannelInboxActions["messageAtDate"];
  loadMessageContext?: ChannelInboxActions["loadMessageContext"];
  send?: ChannelInboxActions["sendText"]; draft: InboxDraft; changeDraft: (draft: InboxDraft, expected?: InboxDraft) => boolean; back: () => void;
  sending: boolean;
  beginSend: () => (() => void) | undefined;
  draftFormatting: DraftRecord<DraftFormatting | undefined>;
  sendFile?: ChannelInboxActions["sendFile"];
  sendAlbum?: ChannelInboxActions["sendAlbum"];
  sendVoice?: ChannelInboxActions["sendVoice"];
  sendVideoNote?: ChannelInboxActions["sendVideoNote"];
  mediaPicker?: InboxMediaPicker;
  reactions?: ChannelInboxActions["reactions"];
  forwarding?: ChannelInboxActions["forwarding"];
  forwardRecipients?: ForwardRecipients;
  copyText?: ChannelInboxActions["copySelectedText"];
  saveAttachments?: ChannelInboxActions["saveSelectedAttachments"];
  openReactionProfile?: OpenInboxReactionProfile;
  clearByDate?: ChannelInboxActions["clearByDate"];
  clearConversation?: ChannelInboxActions["clearConversation"];
  messageDeletable?: ChannelInboxActions["messageDeletable"];
  deleteMessage?: ChannelInboxActions["deleteMessage"];
  deleteSelection?: ChannelInboxActions["deleteSelection"];
  messagePinStatus?: ChannelInboxActions["messagePinStatus"];
  setMessagePinned?: ChannelInboxActions["setMessagePinned"];
  bulkUnpinPreview?: ChannelInboxActions["bulkUnpinPreview"];
  bulkUnpin?: ChannelInboxActions["bulkUnpin"];
  clearDeletedReply: (ids: ReadonlySet<string>) => void;
  conversationCleared: () => void;
  moderation?: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [request, setRequest] = useState<{ before?: string; after?: string }>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string>();
  const [loadedReadInbox, setLoadedReadInbox] = useState<number>();
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  const backButton = useRef<HTMLButtonElement>(null);
  const [historyView, setHistoryView] = useState<{ kind: "search" } | {
    kind: "reply"; messageId: string; quote?: Message["replyQuoteAnchor"];
  }>();
  const returnFocus = useRef<HTMLElement>(null);
  const historyOverlayOpen = historyView !== undefined;
  const [edit, setEdit] = useState<EditDraft>();
  const editing = useRef(false);
  const pinning: MessagePinActions | undefined = messagePinStatus && setMessagePinned ? {
    pinStatus: (_, messageId) => messagePinStatus(channelId, inboxId, topic.id, messageId),
    setMessagePinned: (_, messageId, pinned) => setMessagePinned(channelId, inboxId, topic.id, messageId, pinned),
  } : undefined;
  const bulkUnpinActions: BulkUnpinActions | undefined = bulkUnpinPreview && bulkUnpin ? {
    preview: () => bulkUnpinPreview(channelId, inboxId, topic.id),
    unpin: (_, messageId) => bulkUnpin(channelId, inboxId, topic.id, messageId),
  } : undefined;
  const searchMessages = useCallback(async (_: string, query: string, filter?: MessageSearchFilter, _topic?: number, before?: string,
    _sender?: MessageSender, range?: MessageSearchDateRange) =>
    search!(channelId, inboxId, topic.id, query, before, range, channelInboxSearchFilter.optional().parse(filter)),
  [search, channelId, inboxId, topic.id]);
  const loadAtDate = useCallback((_: string, date: number) =>
    messageAtDate!(channelId, inboxId, topic.id, date), [messageAtDate, channelId, inboxId, topic.id]);
  const loadContext = useCallback((_: string, messageId: string) =>
    loadMessageContext!(channelId, inboxId, topic.id, messageId), [loadMessageContext, channelId, inboxId, topic.id]);
  const loadContextPage = useCallback((_: string, messageId: string, direction: ContextDirection) =>
    loadMessageContext!(channelId, inboxId, topic.id, messageId, direction), [loadMessageContext, channelId, inboxId, topic.id]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const formatting = useDraftFormatting(topic.id, draft.text, composer, [], true, [], draftFormatting);
  const filePicker = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController>(undefined);
  const [uploadProgress, setUploadProgress] = useState<{ bytes: number; total: number; canCancel: boolean }>();
  const splitScope = useRef(0);
  useLayoutEffect(() => () => { splitScope.current++; }, [inboxId, topic.id]);
  const history = useRef<HTMLOListElement>(null);
  const scrollPosition = useRef<"latest" | { openAt: string } | ReturnType<typeof captureHistoryScroll>>(undefined);
  const lastTop = useRef(0);
  const loadingPage = useRef(true);
  const arrivingDuringLoad = useRef<Map<string, Message>>(undefined);
  const forwardCursor = useRef<string>(undefined);
  const bufferedTail = useRef(new Map<string, Message>());
  const deletedIds = useRef(new Set<string>());
  const loadedIds = useRef(new Set<string>());
  const pending = useRef(false);
  const [composerPanel, setComposerPanel] = useState<InboxNoteRecording["kind"] | MediaChoiceSelection["kind"]>();
  const noteKind = composerPanel === "voice" || composerPanel === "video" ? composerPanel : undefined;
  const pickerKind = composerPanel === "sticker" || composerPanel === "gif" ? composerPanel : undefined;
  const [clearState, setClearState] = useState<"idle" | "review" | "clearing" | "refused" | "unknown">("idle");
  const clearing = clearState === "clearing";
  const markRead = useCallback<MarkHistoryRead>(async (_, messageId, _topicId, clearUnreadMark) => {
    if (!markVisible) return false;
    const read = await markVisible(channelId, inboxId, topic.id, messageId, clearUnreadMark);
    if (!read) return false;
    updateReadState(topic.id, read);
    return true;
  }, [channelId, inboxId, markVisible, topic.id, updateReadState]);
  const clearUnreadMark = topic.markedUnread ? true as const : undefined;
  const readInbox = topic.readInbox === undefined ? loadedReadInbox : Math.max(topic.readInbox, loadedReadInbox ?? 0);
  const messageGroups = useMemo(() => groupMessageTimeline(messages), [messages]);
  useVisibleHistoryRead({ list: history, chatId: inboxId, topicId: Number(topic.id), clearUnreadMark, mark: markRead,
    enabled: !!markVisible && readInbox !== undefined && status === "ready" && !historyOverlayOpen && !clearing,
    messageIds: readableHistoryIds(messages, readInbox, deletedIds.current, clearUnreadMark) });
  const rememberScroll = useCallback((mode: "reset" | "prepend" | "incoming" | "keep", excluded?: ReadonlySet<string>) => {
    const list = history.current;
    if (!list?.getClientRects().length || scrollPosition.current) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 40;
    scrollPosition.current = mode === "reset" || mode === "incoming" && nearBottom
      ? "latest" : captureHistoryScroll(list, mode === "prepend" ? "prepend" : "keep", excluded);
  }, []);
  const mergeMessages = useCallback((items: Message[]) => [...new Map(items
    .filter(({ id }) => !deletedIds.current.has(id))
    .map((message) => [message.id, message])).values()].sort((a, b) => Number(a.id) - Number(b.id)), []);
  const acceptMessages = useCallback((items: Message[], changed = false) => {
    const cursor = forwardCursor.current;
    const visible = items.filter((message) => {
      if (deletedIds.current.has(message.id)) return false;
      if (cursor && Number(message.id) > Number(cursor)) {
        bufferedTail.current.set(message.id, message);
        return false;
      }
      arrivingDuringLoad.current?.set(message.id, message);
      return true;
    });
    if (!visible.length) return;
    rememberScroll(changed ? "keep" : "incoming");
    setMessages((previous) => mergeMessages([...previous, ...visible]));
  }, [mergeMessages, rememberScroll]);
  const acceptMessage = useCallback((message: Message, changed = false) => acceptMessages([message], changed), [acceptMessages]);
  const messageScope = useCallback((messageId: string) => ({ id: channelId, inboxId, topicId: topic.id, messageId }), [channelId, inboxId, topic.id]);
  const forwardActions: ForwardActions | undefined = forwarding && forwardRecipients && !clearing ? {
    recipients: forwardRecipients.recipients,
    searchRecipients: forwardRecipients.searchRecipients,
    folders: forwardRecipients.folders,
    communities: forwardRecipients.communities,
    loadTopics: forwardRecipients.loadTopics,
    loadMessageEffects: forwardRecipients.loadMessageEffects,
    canScheduleWhenOnline: forwardRecipients.canScheduleWhenOnline,
    canScheduleRepeats: forwardRecipients.canScheduleRepeats,
    forwardOptions: (_, messageId, album) => forwarding.options(messageScope(messageId), album),
    forwardMessage: (_, messageId, target, album, presentation, delivery, comment) =>
      forwarding.send(messageScope(messageId), target, album, presentation, delivery, comment),
  } : undefined;
  const inboxSelection = forwarding?.selection;
  const batchForward: MessageSelectionActions["batchForward"] = inboxSelection && forwardActions ? {
    options: (_, ids) => inboxSelection.options({ id: channelId, inboxId, topicId: topic.id, ids }),
    send: (_, ids, target, presentation, delivery, comment) =>
      inboxSelection.send({ id: channelId, inboxId, topicId: topic.id, ids }, target, presentation, delivery, comment),
  } : undefined;
  const copySelectedText: MessageSelectionActions["copySelectedText"] = copyText && !clearing
    ? (_, ids, format) => {
      const scope = { id: channelId, inboxId, topicId: topic.id, ids };
      return format ? copyText(scope, format) : copyText(scope);
    } : undefined;
  const saveSelectedAttachments: MessageSelectionActions["saveSelectedAttachments"] = saveAttachments && !clearing
    ? (_, ids, format) => {
      const scope = { id: channelId, inboxId, topicId: topic.id, ids };
      return format ? saveAttachments(scope, format) : saveAttachments(scope);
    } : undefined;
  const selectable = useMemo(() => new Map(messages.filter(({ failedDelivery }) => !failedDelivery).map((message) => [message.id, message])),
    [messages]);
  const loadAvatar = media?.loadAvatar;
  const reactionActions = useMemo<ReactionActions | undefined>(() => reactions && ({
    listReactions: (_, messageId) => reactions.list(messageScope(messageId)),
    setReaction: async (_, messageId, reaction, chosen) => {
      if (clearing || !await reactions.set(messageScope(messageId), reaction, chosen)) return false;
      if (loadMessage && loadedIds.current.has(messageId)) {
        const latest = await loadMessage(channelId, inboxId, topic.id, messageId).catch(() => null);
        if (latest?.id === messageId) acceptMessage(latest, true);
      }
      return true;
    },
    loadPeople: (_, messageId, reaction, offset) => reactions.people(messageScope(messageId), reaction, offset),
    loadAvatar,
  }), [acceptMessage, channelId, clearing, inboxId, loadAvatar, loadMessage, reactions, messageScope, topic.id]);
  const removeMessages = useCallback((messageIds: string[]) => {
    const removed = new Set(messageIds.filter((id) => !deletedIds.current.has(id)));
    if (!removed.size) return;
    rememberScroll("keep", removed);
    for (const id of removed) {
      deletedIds.current.add(id);
      bufferedTail.current.delete(id);
    }
    setMessages((previous) => previous.filter(({ id }) => !removed.has(id)));
    clearDeletedReply(removed);
  }, [clearDeletedReply, rememberScroll]);
  const batchDeletion = useMemo<MessageSelectionActions["batchDeletion"]>(() => deleteSelection && !clearing ? {
    options: async (_, ids) => await deleteSelection.available({ id: channelId, inboxId, topicId: topic.id, ids }) ? ["everyone"] : [],
    remove: async (_, ids, scope) => {
      if (scope !== "everyone") return "refused";
      const outcome = await deleteSelection.remove({ id: channelId, inboxId, topicId: topic.id, ids });
      if (outcome === "deleted") removeMessages(ids);
      return outcome;
    },
  } : undefined, [channelId, clearing, deleteSelection, inboxId, removeMessages, topic.id]);
  const selection = useMessageSelection(inboxId, selectable, { batchForward, batchDeletion, copySelectedText, saveSelectedAttachments },
    forwardActions, !!(batchForward || batchDeletion || copySelectedText || saveSelectedAttachments) && !historyOverlayOpen && !edit && !composerPanel,
    deletedIds.current, topic.id);
  useEffect(() => { backButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => () => upload.current?.abort(), []);
  useLayoutEffect(() => {
    loadedIds.current = new Set(messages.map(({ id }) => id));
    const list = history.current;
    const position = scrollPosition.current;
    scrollPosition.current = undefined;
    if (!list || !position) return;
    if (position === "latest") list.scrollTop = list.scrollHeight;
    else if ("openAt" in position) {
      const row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"))
        .find((item) => item.dataset.messageId === position.openAt);
      if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    } else restoreHistoryScroll(list, position);
    lastTop.current = list.scrollTop;
  }, [messages]);
  useEffect(() => {
    let active = true;
    const arriving = new Map<string, Message>();
    loadingPage.current = true;
    arrivingDuringLoad.current = arriving;
    void load(channelId, inboxId, topic.id, request.before, request.after).then((page) => {
      if (!active) return;
      arrivingDuringLoad.current = undefined;
      const paginating = !!(request.before || request.after);
      if (!request.before) {
        forwardCursor.current = page.after;
        setAfter(page.after);
      }
      const tail = [...arriving.values(), ...(!request.before && !page.after ? bufferedTail.current.values() : [])];
      if (!request.before && !page.after) bufferedTail.current.clear();
      const visibleTail = tail.filter((message) => {
        if (!forwardCursor.current || Number(message.id) <= Number(forwardCursor.current)) return true;
        bufferedTail.current.set(message.id, message);
        return false;
      });
      if (page.openAt) scrollPosition.current = { openAt: page.openAt };
      else rememberScroll(request.before ? "prepend" : request.after ? "keep" : "reset");
      setMessages((previous) => mergeMessages([...page.messages, ...(paginating ? previous : []), ...visibleTail]));
      if (!request.after) setBefore(page.before);
      const readInbox = page.readInbox;
      if (readInbox !== undefined) setLoadedReadInbox((previous) => Math.max(previous ?? 0, readInbox));
      loadingPage.current = false;
      setStatus("ready");
    }, () => {
      if (!active) return;
      arrivingDuringLoad.current = undefined;
      loadingPage.current = false;
      setStatus("failed");
    });
    return () => {
      active = false;
      arrivingDuringLoad.current = undefined;
    };
  }, [channelId, inboxId, load, mergeMessages, rememberScroll, request, topic.id]);
  function loadMore(direction: "up" | "down", list?: HTMLOListElement) {
    if (loadingPage.current || status !== "ready" || clearing) return;
    const cursor = direction === "up" ? before : after;
    const distance = !list ? 0 : direction === "up" ? list.scrollTop : list.scrollHeight - list.clientHeight - list.scrollTop;
    if (!cursor || distance > 64) return;
    loadingPage.current = true;
    setStatus("loading");
    setRequest(direction === "up" ? { before: cursor } : { after: cursor });
  }
  useEffect(() => {
    if (!loadMessage || !subscribeToMessages) return;
    let active = true;
    const pending = new Set<string>();
    const changedWhilePending = new Set<string>();
    function refresh(messageId: string, changed: boolean) {
      pending.add(messageId);
      void loadMessage!(channelId, inboxId, topic.id, messageId).then((message) => {
        if (active && message?.id === messageId) acceptMessage(message, changed);
      }, () => undefined).finally(() => {
        pending.delete(messageId);
        if (changedWhilePending.delete(messageId) && active && !deletedIds.current.has(messageId)) refresh(messageId, true);
      });
    }
    const unsubscribe = subscribeToMessages((event) => {
      const { id, messageId, kind } = event;
      if (id !== inboxId || deletedIds.current.has(messageId)) return;
      if (kind === "arrived" && event.topicId !== topic.id) return;
      if (pending.has(messageId)) {
        if (kind === "changed") changedWhilePending.add(messageId);
        return;
      }
      if (kind === "changed" && !loadedIds.current.has(messageId)) return;
      refresh(messageId, kind === "changed");
    });
    return () => { active = false; unsubscribe(); };
  }, [acceptMessage, channelId, inboxId, loadMessage, subscribeToMessages, topic.id]);
  useEffect(() => subscribeToDeletions?.(({ id, messageIds }) => {
    if (id === inboxId) removeMessages(messageIds);
  }), [inboxId, removeMessages, subscribeToDeletions]);
  const file = draft.file;
  const mediaKind = file && inboxMediaKind(file);
  const albumFiles = draft.album?.files;
  const matchingAlbum = albumFiles && inboxAlbumItems(albumFiles);
  const albumItems = albumFiles && (draft.album?.asDocuments || !matchingAlbum
    ? albumFiles.map((file): InboxAlbumItem => ({ kind: "document", file })) : matchingAlbum);
  const attachments = albumFiles ?? (file ? [file] : []);
  const totalBytes = attachments.reduce((total, item) => total + item.size, 0);
  const attachmentError = attachments.length > 10 ? "Choose at most 10 files for an album."
    : attachments.some(({ size }) => size <= 0) ? "Choose nonempty files."
    : attachments.some(({ size }) => size > maxTelegramUploadBytes) ? "Telegram supports uploads up to 4000 MiB per file."
    : attachments.length && draft.text.trim().length > 1024 ? "The caption can contain up to 1024 characters." : undefined;
  const longDraft = !attachments.length && draft.text.trim().length > maxTelegramTextLength;
  const canSendTextFile = !!send && !!sendFile && !attachments.length;
  const canSplitText = !!send && !attachments.length;
  const draftLimit = attachments.length ? 1024 : canSplitText ? undefined : maxTelegramTextLength;
  const canSend = !formatting.editingLink && !attachmentError && !longDraft && (albumItems ? !!sendAlbum : file ? !!sendFile : !!send && !!draft.text.trim());
  function changeText(text: string) {
    changeDraft({ ...draft, text, outcome: draft.outcome === "failed" ? undefined : draft.outcome, uploadRejection: undefined });
  }
  async function submit(asTextFile = false) {
    const text = draft.text.trim();
    if ((asTextFile ? !canSendTextFile || !longDraft || formatting.editingLink : !canSend)
      || status !== "ready" || clearing || draft.outcome === "unknown" || pending.current) return;
    const endSend = beginSend();
    if (!endSend) return;
    pending.current = true;
    const outgoingFile = asTextFile ? textDraftAttachment(draft.text).file : file;
    const total = asTextFile && outgoingFile ? outgoingFile.size : totalBytes;
    const controller = total > 0 ? new AbortController() : undefined;
    upload.current = controller;
    if (controller) setUploadProgress({ bytes: 0, total, canCancel: true });
    const progress: Parameters<DocumentSender>[3] = (bytes, canCancel, telegram) => {
      const uploaded = telegram ? Math.round(telegram.uploaded / telegram.total * total) : bytes;
      setUploadProgress({ bytes: uploaded, total, canCancel: canCancel ?? true });
    };
    const format: [CaptionFormat?] = !asTextFile && formatting.captionFormat ? [formatting.captionFormat] : [];
    try {
      const result = await (albumItems && controller
        ? sendAlbum!(channelId, inboxId, topic.id, albumItems, text, draft.replyTo, progress, controller.signal, ...format)
        : outgoingFile && controller ? sendFile!(channelId, inboxId, topic.id, outgoingFile, asTextFile ? "" : text,
          draft.replyTo, progress, controller.signal, asTextFile ? "document" : draft.kind, ...format)
        : send!(channelId, inboxId, topic.id, text, draft.replyTo, ...format)).catch(() => ({ state: "unknown" as const }));
      if (result.state === "sent") {
        if (changeDraft(emptyInboxDraft, draft)) formatting.reset();
        acceptMessages(result.album ?? [result.message]);
      } else if (result.state !== "cancelled") changeDraft({ ...draft, outcome: result.state === "failed" ? "failed" : "unknown",
        uploadRejection: result.state === "failed" ? result.uploadRejection : undefined }, draft);
    } finally {
      upload.current = undefined;
      setUploadProgress(undefined);
      pending.current = false;
      endSend();
    }
  }
  async function submitParts() {
    if (!send || !canSplitText || !longDraft || formatting.editingLink || status !== "ready" || clearing
      || draft.outcome === "unknown" || pending.current) return;
    const endSend = beginSend();
    if (!endSend) return;
    pending.current = true;
    const scope = splitScope.current;
    try {
      const result = await sendSplitDraft(draft.text, formatting.captionFormat, () => scope === splitScope.current,
        (part, style, first) => send(channelId, inboxId, topic.id, part, first ? draft.replyTo : undefined, style), acceptMessage);
      if (changeDraft({ ...draft, text: result.remaining, replyTo: result.sentAny ? undefined : draft.replyTo,
        outcome: result.status, uploadRejection: undefined }, draft) && result.sentAny) {
        formatting.restore({ ...result.format, links: result.format.links ?? [], text: result.remaining });
      }
    } finally {
      pending.current = false;
      endSend();
    }
  }
  async function submitExtra(dispatch: () => Promise<SendResult> | undefined): Promise<SendResult> {
    if (pending.current || status !== "ready" || clearing) return { state: "failed" };
    const endSend = beginSend();
    if (!endSend) return { state: "failed" };
    pending.current = true;
    try {
      const result = await dispatch() ?? { state: "failed" as const };
      if (result.state === "sent") {
        acceptMessage(result.message);
        changeDraft({ ...draft, replyTo: undefined }, draft);
      }
      return result;
    } finally {
      pending.current = false;
      endSend();
    }
  }
  const saveEdit: ComponentProps<typeof MessageEdit>["save"] = async (event, styles, removeLinkPreview, placement, links, customEmoji) => {
    event.preventDefault();
    if (!edit || edit.busy || editing.current || (edit.message.editableCaption ? !editCaption : !editText)) return;
    const textAction: EditText | undefined = editText
      ? (_, messageId, text, original, originalStyles, styles, removeLinkPreview, links, _scheduled, customEmoji) =>
        editText(channelId, inboxId, topic.id, { messageId, text, original, originalStyles, styles, removeLinkPreview, links, customEmoji })
      : undefined;
    const captionAction: EditCaption | undefined = editCaption
      ? (_, messageId, text, original, originalStyles, styles, placement, links, _scheduled, customEmoji) =>
        editCaption(channelId, inboxId, topic.id, { messageId, text, original, originalStyles, styles, placement, links, customEmoji })
      : undefined;
    editing.current = true;
    setEdit({ ...edit, busy: true, error: undefined });
    const result = await submitMessageEdit(inboxId, edit.message, edit.text.trim(), { editText: textAction, editCaption: captionAction },
      styles, removeLinkPreview, placement, links, undefined, customEmoji)?.catch(() => undefined);
    editing.current = false;
    if (result?.state === "sent") {
      acceptMessage(result.message, true);
      setEdit(undefined);
    } else {
      setEdit({ ...edit, busy: false, error: result?.state === "failed"
        ? "The message changed or Telegram refused the edit. Your draft is still here."
        : "Telegram did not confirm the edit. Check the message before retrying." });
    }
  };
  async function confirmClear() {
    if (!clearConversation || clearState !== "review" || pending.current || status !== "ready") return;
    pending.current = true;
    setClearState("clearing");
    const outcome = await clearConversation(channelId, inboxId, topic.id).catch(() => "unknown" as const);
    pending.current = false;
    if (outcome === "deleted") {
      changeDraft({ ...draft, replyTo: undefined });
      conversationCleared();
      return;
    }
    setClearState(outcome);
    if (outcome === "unknown") {
      setStatus("loading");
      setRequest({});
    }
  }
  const replyId = typeof draft.replyTo === "string" ? draft.replyTo : draft.replyTo?.messageId;
  const quote = typeof draft.replyTo === "object" ? draft.replyTo.quote : undefined;
  const replyTarget = messages.find(({ id }) => id === replyId);
  const replyControls = replyId && <div className="mtg-reply-preview">
    <div>
      <span>{tr("Replying to ")}<bdi>{replyTarget?.author ?? tr("an earlier message")}</bdi></span>
      {quote && <p>{quote.text}</p>}
      {replyTarget?.canQuote && <SelectReplyQuote key={replyId} text={replyTarget.text} layout={replyTarget.richMessage}
        quote={quote} disabled={sending || clearing}
        change={(value) => changeDraft({ ...draft, replyTo: value ? { messageId: replyId, quote: value } : replyId })} />}
    </div>
    <button type="button" className="mtg-action" disabled={sending || clearing} onClick={() => changeDraft({ ...draft, replyTo: undefined })}>{tr("Cancel reply")}</button>
  </div>;
  const conversation = <section aria-label={topic.name} hidden={historyOverlayOpen} onKeyDown={(event) => {
    const busy = sending || clearState === "review" || clearing || composerPanel || edit || selection.active;
    if (inboxEscape(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        if (event.target === composer.current && replyId) changeDraft({ ...draft, replyTo: undefined });
        else back();
      }
      return;
    }
    if (busy || !search || !inboxFind(event)) return;
    event.preventDefault();
    event.stopPropagation();
    returnFocus.current = event.target instanceof HTMLElement ? event.target : backButton.current;
    setHistoryView({ kind: "search" });
  }}>
    <header><h3><bdi>{topic.name}</bdi></h3><button ref={backButton} autoFocus type="button" className="mtg-action" disabled={sending || clearing} onClick={back}>{tr("Back to inbox")}</button>
      {search && <button type="button" className="mtg-action" disabled={sending || clearing || !!composerPanel}
        aria-keyshortcuts="Meta+F Control+F Alt+Shift+F"
        onClick={(event) => {
          returnFocus.current = event.currentTarget;
          setHistoryView({ kind: "search" });
        }}>{tr("Search conversation")}</button>}
    </header>
    {moderation}
    {clearConversation && <section aria-label={tr("Clear channel conversation")}>
      {clearState === "review" || clearing ? <>
        <p>{tr("Clear all messages in the channel conversation with ")}<bdi>{topic.name}</bdi>{tr("? This cannot be undone.")}</p>
        <button type="button" className="mtg-action" autoFocus disabled={clearing} onClick={() => setClearState("idle")}>{tr("Cancel")}</button>
        <button type="button" className="mtg-action" disabled={clearing || sending || status !== "ready"} onClick={() => void confirmClear()}>{tr("Confirm clearing all messages")}</button>
        {clearing && <p role="status">{tr("Clearing conversation…")}</p>}
      </> : <button type="button" className="mtg-action" disabled={sending || status !== "ready"}
        onClick={() => setClearState("review")}>{tr("Clear all messages")}</button>}
      {clearState === "refused" && <p role="status">{tr("Could not clear the conversation.")}</p>}
      {clearState === "unknown" && <p role="status">{tr("Telegram did not confirm the result. Check the conversation before trying again.")}</p>}
    </section>}
    {clearByDate && <ClearChatHistoryByDate name={topic.name} disabled={clearing} clearInbox={async (range) => {
      const outcome = await clearByDate(channelId, inboxId, topic.id, range).catch(() => "unknown" as const);
      if (outcome === "deleted" || outcome === "unknown") {
        setStatus("loading");
        setRequest({});
      }
      return outcome;
    }} />}
    {status === "loading" && <p role="status">{tr("Loading channel messages…")}</p>}
    {status === "failed" && <p role="alert">{tr("Could not load channel messages. ")}<button type="button" className="mtg-action" onClick={() => {
      setStatus("loading");
      setRequest({ ...request });
    }}>{tr("Retry")}</button></p>}
    {status === "ready" && before && <button type="button" className="mtg-action" onClick={() => loadMore("up")}>{tr("Load earlier messages")}</button>}
    {status === "ready" && messages.length === 0 && <p>{tr("No messages in this conversation")}</p>}
    {selection.start()}
    <ol ref={history} tabIndex={0} className="mtg-channel-inbox-history" aria-label={tr("Channel inbox messages")}
      onScroll={(event) => {
        const list = event.currentTarget;
        const previous = lastTop.current;
        lastTop.current = list.scrollTop;
        if (list.scrollTop !== previous) loadMore(list.scrollTop < previous ? "up" : "down", list);
      }}
      onWheel={(event) => {
        const direction = historyWheelDirection(event);
        if (direction) loadMore(direction, event.currentTarget);
      }}>
      {messageGroups.flatMap(({ group, albumKey }) => {
        const caption = sharedAlbumCaption(group);
        const rows = group.map((message) => {
          const available = !message.pendingDelivery && !message.failedDelivery && !message.retained && /^[1-9]\d{0,15}$/.test(message.id);
          const replyId = message.replyTo;
          const replyUnavailable = replyId !== undefined && deletedIds.current.has(replyId);
          const canOpenReply = !!loadMessageContext && !!replyId && !replyUnavailable;
          const replyText = replyUnavailable ? "Original message unavailable" : message.replyQuote ?? "Earlier message";
          return <li key={message.id} data-context-object data-message-id={message.id} className="mtg-channel-inbox-message">
            {selection.checkbox(message)}
            <div><strong><bdi>{message.author}</bdi></strong> <MessageTimestamp message={message} /></div>
            {(replyId || message.replyQuote) && <blockquote className="mtg-reply-quote">
              {canOpenReply ? <button type="button" className="mtg-open-reply" aria-label={tr("Open original message")}
                onClick={(event) => {
                  returnFocus.current = event.currentTarget;
                  setHistoryView({ kind: "reply", messageId: replyId, quote: message.replyQuoteAnchor });
                }}>{replyText}</button> : replyText}
            </blockquote>}
            <MessageContent chatId={inboxId} message={message} hideCaption={caption?.message.id === message.id}
              reactionActions={reactionActions} forwardActions={forwardActions} {...media} />
            {(send || sendVoice || sendVideoNote || mediaPicker) && available && <button type="button" className="mtg-action"
              disabled={sending || clearing || !!composerPanel} onMouseDown={(event) => {
              if (event.button === 0 && selectedReplyQuote(history.current, message)) event.preventDefault();
            }} onClick={(event) => {
              const quote = selectedReplyQuote(history.current, message);
              if (quote) event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();
              changeDraft({ ...draft, replyTo: quote ? { messageId: message.id, quote } : message.id });
              composer.current?.focus();
            }}>{tr("Reply to message")}</button>}
            {available && message.outgoing && (message.editableCaption ? editCaption : message.editable && editText)
              && <button type="button" className="mtg-action" disabled={sending || clearing || !!edit || !!composerPanel}
                onClick={() => setEdit({ message, text: editableMessageText(message), busy: false })}>
                {message.editableCaption ? tr("Edit caption") : tr("Edit message")}
              </button>}
            {available && pinning && <MessagePin {...pinning} chatId={inboxId} messageId={message.id} inTopic />}
            {available && messageDeletable && deleteMessage && <MessageDeletion chatId={inboxId} messageId={message.id}
              disabled={sending || clearing || status !== "ready"}
              deletionOptions={async (_, messageId) => await messageDeletable(channelId, inboxId, topic.id, messageId) ? ["everyone"] : []}
              deleteMessage={async (_, messageId) => {
                const outcome = await deleteMessage(channelId, inboxId, topic.id, messageId);
                if (outcome === "deleted") removeMessages([messageId]);
                return outcome;
              }} />}
          </li>;
        });
        return albumKey && group.length > 1
          ? [<MessageAlbum key={albumKey} first={group[0]!} caption={caption} messages={group} chatId={inboxId}
            forward={forwardActions}>{rows}</MessageAlbum>]
          : rows;
      })}
    </ol>
    {status === "ready" && after && <button type="button" className="mtg-action" onClick={() => loadMore("down")}>{tr("Load newer messages")}</button>}
    {selection.toolbar}
    <div className="mtg-compose-region" hidden={selection.active}>
    {edit ? <MessageEdit key={edit.message.id} draft={edit} change={(text) => setEdit({ ...edit, text })}
      cancel={() => setEdit(undefined)} save={saveEdit} /> : noteKind
      ? <ChannelInboxNote key={noteKind} kind={noteKind} reply={replyControls} disabled={sending || clearing || status !== "ready"}
        send={(recording) => submitExtra(() => recording.kind === "voice"
          ? sendVoice?.(channelId, inboxId, topic.id, recording, draft.replyTo)
          : sendVideoNote?.(channelId, inboxId, topic.id, recording, draft.replyTo))} close={() => setComposerPanel(undefined)} />
      : pickerKind && mediaPicker
        ? <ChannelInboxMediaPicker key={pickerKind} kind={pickerKind} actions={mediaPicker} reply={replyControls}
          disabled={sending || clearing || status !== "ready"}
          send={(selection) => submitExtra(() => mediaPicker.send(channelId, inboxId, topic.id, selection, draft.replyTo))}
          close={() => setComposerPanel(undefined)} />
      : (send || sendFile || sendAlbum || sendVoice || sendVideoNote || mediaPicker) && <form className="mtg-channel-inbox-composer" onSubmit={(event) => {
      event.preventDefault();
      void submit();
    }}>
      {replyControls}
      {sendVoice && <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"}
        onClick={() => setComposerPanel("voice")}>{tr("Voice note")}</button>}
      {sendVideoNote && <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"}
        onClick={() => setComposerPanel("video")}>{tr("Video note")}</button>}
      {mediaPicker && <div>
        <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"}
          onClick={() => setComposerPanel("sticker")}>{tr("Stickers")}</button>
        <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"}
          onClick={() => setComposerPanel("gif")}>{tr("Saved GIFs")}</button>
      </div>}
      {(sendFile || sendAlbum) && <div>
        <input ref={filePicker} type="file" aria-label={tr("Choose channel attachment")} hidden multiple={!!sendAlbum} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 1 && sendAlbum) changeDraft({ ...draft, file: undefined, kind: undefined,
            album: { files, asDocuments: !inboxAlbumItems(files) }, outcome: undefined, uploadRejection: undefined });
          else if (files[0]) changeDraft({ ...draft, file: files[0], kind: inboxMediaKind(files[0]),
            album: undefined, outcome: undefined, uploadRejection: undefined });
        }} />
        <button type="button" className="mtg-action" disabled={sending || clearing || draft.outcome === "unknown"}
          onClick={() => filePicker.current?.click()}>{tr("Attach file")}</button>
        {attachments.length > 0 && <> <bdi>{file?.name ?? tr("{0} files", [attachments.length])}</bdi>
          <button type="button" className="mtg-action" disabled={sending || clearing || draft.outcome === "unknown"}
            onClick={() => changeDraft({ ...draft, file: undefined, kind: undefined, album: undefined,
              outcome: undefined, uploadRejection: undefined })}>{albumFiles ? tr("Remove album") : tr("Remove attachment")}</button></>}
        {albumFiles && <ul aria-label={tr("Selected album files")}>
          {albumFiles.map(({ name }, index) => <li key={index}><bdi>{name}</bdi></li>)}
        </ul>}
        {mediaKind && <label>{tr("Send as ")}<select value={draft.kind ?? "document"} disabled={sending || clearing || draft.outcome === "unknown"}
          onChange={(event) => changeDraft({ ...draft, kind: event.currentTarget.value === mediaKind ? mediaKind : "document",
            outcome: undefined, uploadRejection: undefined })}>
          <option value={mediaKind}>{tr(inboxMediaLabels[mediaKind])}</option><option value="document">{tr("Document")}</option>
        </select></label>}
        {albumFiles && matchingAlbum && <label>{tr("Send as ")}<select value={draft.album?.asDocuments ? "document" : "media"}
          disabled={sending || clearing || draft.outcome === "unknown"}
          onChange={(event) => changeDraft({ ...draft, album: { files: albumFiles, asDocuments: event.currentTarget.value === "document" },
            outcome: undefined, uploadRejection: undefined })}>
          <option value="media">{matchingAlbum[0]?.kind === "audio" ? tr("Audio album") : tr("Media album")}</option>
          <option value="document">{tr("Document album")}</option>
        </select></label>}
      </div>}
      <textarea ref={composer} aria-label={albumFiles ? tr("Write an album caption") : file ? tr("Write a file caption") : tr("Write a channel reply")}
        maxLength={draftLimit}
        readOnly={sending || clearing} value={draft.text}
        aria-keyshortcuts={`${draftFormattingShortcuts} ${draftLinkShortcuts}`}
        onSelect={(event) => formatting.select(event.currentTarget)}
        onKeyDown={(event) => { if (!sending && !clearing) formatting.shortcut(event); }}
        onPaste={(event) => { if (!sending && !clearing) formatting.paste(event, changeText); }}
        onChange={(event) => {
          formatting.change(event.currentTarget.value, event.currentTarget.selectionEnd);
          changeText(event.currentTarget.value);
        }} />
      <DraftFormatButton formatting={formatting} busy={sending || clearing} />
      <DraftFormatControls formatting={formatting} busy={sending || clearing} previewLabel={attachments.length ? "Formatted caption preview" : "Formatted reply preview"} />
      {longDraft && <div className="mtg-long-draft">
        <p role="status">{canSplitText ? tr("This draft exceeds Telegram’s message limit. Choose how to send it.")
          : tr("Shorten this draft to send it as a message.")}</p>
        {canSplitText && <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"
          || draft.outcome === "unknown" || !!formatting.editingLink} onClick={() => void submitParts()}>{tr("Send as multiple messages")}</button>}
        {canSendTextFile && <button type="button" className="mtg-action" disabled={sending || clearing || status !== "ready"
          || draft.outcome === "unknown" || !!formatting.editingLink}
          onClick={() => void submit(true)}>{tr("Send as text file")}</button>}
      </div>}
      <button type="submit" className="mtg-action" disabled={sending || clearing || status !== "ready" || draft.outcome === "unknown"
        || !canSend}>
        {albumFiles ? tr("Send album") : file ? tr("Send file") : tr("Send channel reply")}
      </button>
      {attachmentError && <p role="alert">{tr(attachmentError)}</p>}
      {uploadProgress ? <div>
        <progress aria-label={albumFiles ? tr("Album upload progress") : tr("File upload progress")} max={uploadProgress.total}
          value={Math.min(uploadProgress.total, uploadProgress.bytes)} />
        {uploadProgress.canCancel && <button type="button" className="mtg-action" onClick={() => upload.current?.abort()}>{tr("Cancel upload")}</button>}
      </div> : sending && <p role="status">{tr("Sending reply…")}</p>}
      {draft.outcome === "failed" && <p role="alert">{draft.uploadRejection === "premium_required"
        ? tr("Telegram Premium is required for this file size.")
        : draft.uploadRejection === "reply_unavailable" ? tr("The reply target is no longer available.")
        : draft.uploadRejection === "legacy_tdlib" ? tr("Update TDLib to send this file.")
        : draft.uploadRejection === "file_too_large" ? tr("This file exceeds Telegram’s upload limit.")
        : draft.uploadRejection === "video_preparation_failed" || draft.uploadRejection === "media_preparation_failed"
          ? tr("Could not prepare this media. You can try sending it as a document.")
        : tr("Could not send the reply. The draft is still here.")}</p>}
      {draft.outcome === "unknown" && <div>
        <p role="alert">{tr("Telegram did not confirm delivery. Check the conversation before retrying.")}</p>
        <button type="button" className="mtg-action" disabled={status === "loading"} onClick={() => {
          setStatus("loading");
          setRequest({});
        }}>{tr("Refresh conversation")}</button>
        <button type="button" className="mtg-action" disabled={status !== "ready"}
          onClick={() => changeDraft({ ...draft, outcome: undefined })}>{tr("Allow retry")}</button>
      </div>}
    </form>}
    </div>
  </section>;
  const inboxHistoryUpdates = useMemo<HistoryMessageUpdateActions | undefined>(() => loadMessage && subscribeToMessages ? {
    subscribeToDeletions,
    subscribe: (listener) =>
      subscribeToMessages((event) => {
        if (event.kind === "changed" && event.id === inboxId) listener(event);
      }),
    load: (_id: string, messageId: string) => loadMessage(channelId, inboxId, topic.id, messageId),
  } : undefined, [channelId, inboxId, loadMessage, subscribeToDeletions, subscribeToMessages, topic.id]);
  return <OpenReactionPerson.Provider value={reactions && openReactionProfile
    ? (_, messageId, target, signal) => openReactionProfile(target, signal, () => reactions.person(messageScope(messageId), target))
    : undefined}>
    {conversation}
    {historyView && <section aria-label={topic.name} onKeyDown={(event) => {
      if (!search || !inboxFind(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const input = event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]');
      if (input && !input.disabled) { input.focus(); input.select(); }
      else if (historyView.kind !== "search") setHistoryView({ kind: "search" });
    }}>
      <h3><bdi>{topic.name}</bdi></h3>
      <HistoryMessageUpdates.Provider value={inboxHistoryUpdates}><ConversationSearch chatId={inboxId} search={search ? searchMessages : undefined} searchTypes={channelInboxSearchFilter.options}
        initialMessage={historyView.kind === "reply" ? historyView.messageId : undefined}
        initialQuote={historyView.kind === "reply" ? historyView.quote : undefined}
        backLabel={tr("Back to channel conversation")}
        reactionActions={reactionActions} forwardActions={forwardActions} batchForward={batchForward}
        batchDeletion={batchDeletion} copySelectedText={copySelectedText}
        saveSelectedAttachments={saveSelectedAttachments} saveSelectedAttachmentsInSearch
        pinning={pinning} pinInTopic bulkUnpin={bulkUnpinActions} bulkUnpinName={topic.name}
        loadContext={loadMessageContext ? loadContext : undefined} {...media}
        loadContextPage={loadMessageContext ? loadContextPage : undefined}
        loadAtDate={messageAtDate ? loadAtDate : undefined}
        deletedIds={deletedIds.current} close={() => {
          setHistoryView(undefined);
          const trigger = returnFocus.current;
          returnFocus.current = null;
          requestAnimationFrame(() => (trigger?.isConnected ? trigger : backButton.current)?.focus({ preventScroll: true }));
        }} /></HistoryMessageUpdates.Provider>
    </section>}
  </OpenReactionPerson.Provider>;
}

function inboxFind(event: KeyboardEvent<HTMLElement>) {
  return isFindShortcut(event, event.currentTarget)
    || (event.code === "KeyF" && isPanelShortcut(event, event.currentTarget));
}

function ChannelInboxModeration({ channelName, load, change }: {
  channelName: string;
  load: () => Promise<ChannelInboxBan | null>;
  change: (expected: ChannelInboxBan) => Promise<"updated" | "changed" | "unavailable" | "unknown">;
}) {
  const { t: tr } = useTelegramLocale();
  const [review, setReview] = useState<ChannelInboxBan>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const pending = useRef(false);
  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    try { await operation(); }
    finally { pending.current = false; setBusy(false); }
  }
  function prepare() {
    return run(async () => {
      const current = await load().catch(() => null);
      if (current) setReview(current);
      else setStatus("Channel moderation is unavailable for this correspondent.");
    });
  }
  function confirm(expected: ChannelInboxBan) {
    return run(async () => {
      const result = await change(expected).catch(() => "unknown" as const);
      setReview(undefined);
      setStatus(result === "updated" ? expected.role === "banned" ? "Channel ban lifted." : "User banned from the channel."
        : result === "changed" ? "The correspondent’s channel status changed. Review it again."
        : result === "unavailable" ? "Telegram refused the change or channel moderation is unavailable."
        : "Telegram did not confirm the change. Check the current channel ban status.");
    });
  }
  const unban = review?.role === "banned";
  return <section aria-label={tr("Channel inbox moderation")}>
    {!review ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void prepare()}>{tr("Review channel ban")}</button>
      : <div>
        <p>{unban ? tr("Lift the channel ban for") : tr("Permanently ban")} <bdi>{review.name}</bdi> {unban ? tr("in") : tr("from")} <bdi>{channelName}</bdi>?</p>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm(review)}>
          {unban ? tr("Confirm channel unban") : tr("Confirm channel ban")}
        </button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
      </div>}
    {status && <p role="status">{tr(status)}</p>}
  </section>;
}
