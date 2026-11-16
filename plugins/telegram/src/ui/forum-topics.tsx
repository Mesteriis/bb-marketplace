import { MediaComposer, type ComposerMediaActions } from "./media-composer.tsx";
import { TopicDraftSync, type TopicDraftActions } from "./topic-draft-sync.tsx";
import { hasWebLink } from "../core/message-links.ts";
import { LinkPreviewControls, linkPreviewDelivery, type LinkPreviewChoice } from "./link-preview-controls.tsx";
import { ServiceMessageRow } from "./service-message.tsx";
import { submitComposerOnEnter } from "./composer-keys.ts";
import { MediaSendControls } from "./media-send-controls.tsx";
import type { CaptionPlacement, MediaSendOptions, ForumTopicAction, ForumTopicPage, ReplyQuote, StyledRange, TopicDelivery } from "../core/contract.ts";
import { Camera, Paperclip, Pencil, Pin, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { maxTelegramUploadBytes, type DocumentSender, type ForumTopic, type ForumTopicTarget, type MediaReply, type HistoryPage, type PollSender, type SendResult, type UploadRejection } from "../core/contract.ts";
import { previewMessageText } from "../core/message-spoilers.ts";
import { fillHistoryGap, mergeLatestHistory } from "../core/history-refresh.ts";
import type { Chat, Message } from "../core/demo.ts";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";
import { ConversationSearch, type AuthorFilter } from "./conversation-search.tsx";
import { CopyMessageReference, CopyRecipientReference } from "./copy-message-reference.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { MessageViewers, type MessageViewerLoader } from "./message-viewers.tsx";
import { ChatNotifications, type ChatNotificationActions } from "./chat-notifications.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { MessageEdit, editableMessageText, submitMessageEdit, type EditCaption, type EditDraft, type EditText } from "./message-edit.tsx";
import { SelectReplyQuote } from "./select-reply-quote.tsx";
import { ScheduledMessages } from "./scheduled-messages.tsx";
import { MessagePin, type MessagePinActions } from "./message-pin.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { PollComposer } from "./poll-composer.tsx";
import { MessageAlbum, sharedAlbumCaption } from "./message-album.tsx";
import { groupMessageTimeline, localDateInputValue } from "../core/message-timeline.ts";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { MessageContent, type MediaCollectionActions } from "./message-content.tsx";

export type ManageForumTopic = (id: string, action: ForumTopicAction) => Promise<ForumTopic>;
export type ForumActions = {
  loadForumTopics: (chatId: string, query: string) => Promise<ForumTopic[] | null>;
  sendTopicText: (chatId: string, topic: ForumTopicTarget, text: string, replyTo?: string, styles?: StyledRange[], quote?: ReplyQuote, delivery?: TopicDelivery) => Promise<SendResult>;
  loadTopicHistory: (chatId: string, topicId: number, before?: string) => Promise<HistoryPage>;
};

type TopicMessageActions = Partial<MessagePinActions & MessageDeletionActions & ChatNotificationActions> & {
  editText?: EditText;
  editCaption?: EditCaption;
  mediaCollection?: MediaCollectionActions;
  messageViewers?: MessageViewerLoader;
  searchMessages?: ComponentProps<typeof ConversationSearch>["search"];
  markActivityRead?: ComponentProps<typeof ConversationSearch>["markActivityRead"];
  loadMessageContextPage?: ComponentProps<typeof ConversationSearch>["loadContextPage"];
  loadMessageAtDate?: ComponentProps<typeof ConversationSearch>["loadAtDate"];
  loadMessageContext?: ComponentProps<typeof ConversationSearch>["loadContext"];
};

export function ForumTopics({ chatId, chat, loadAvatar, loadMessageLink, topics, liveRevision, loadForumTopics, manageTopic, loadTopicDraft, saveTopicDraft, loadTopicPage, loadTopicHistory, sendTopicText, scheduleActions, sendDocument, sendPhoto, sendPoll, allowVideoAttachment, allowDocumentAttachment = true, mediaComposer, mediaPermissions, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, messageActions, deletedIds, close }: Omit<ForumActions, "sendTopicText"> & {
  sendTopicText?: ForumActions["sendTopicText"];
  scheduleActions?: Pick<ComponentProps<typeof ScheduledMessages>, "load" | "change" | "cancel" | "checkRepeat">;
  sendPoll?: PollSender;
  mediaComposer?: (id: string, topic: ForumTopicTarget, reply?: MediaReply) => ComposerMediaActions;
  mediaPermissions?: { photos: boolean; voice: boolean; videoNote?: boolean; otherMedia: boolean };
  sendDocument?: DocumentSender;
  allowVideoAttachment?: boolean;
  allowDocumentAttachment?: boolean;
  sendPhoto?: (id: string, caption: string, base64: string, topic?: ForumTopicTarget, replyTo?: string, options?: MediaSendOptions) => Promise<SendResult>;
  chatId: string;
  chat?: Chat;
  loadAvatar?: AvatarLoader;
  loadMessageLink?: MessageLinkLoader;
  topics: ForumTopic[];
  manageTopic?: ManageForumTopic;
  loadTopicDraft?: TopicDraftActions["load"];
  saveTopicDraft?: TopicDraftActions["save"];
  loadTopicPage?: (chatId: string, query: string, cursor?: NonNullable<ForumTopicPage["next"]>) => Promise<ForumTopicPage | null>;
  liveRevision?: number;
  loadPhoto: ComponentProps<typeof MessageContent>["loadPhoto"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument: ComponentProps<typeof MessageContent>["saveDocument"];
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  messageActions?: TopicMessageActions;
  deletedIds?: ReadonlySet<string>;
  close: () => void;
}) {
  const [linkPreviews, setLinkPreviews] = useState<Record<number, LinkPreviewChoice | undefined>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [delivery, setDelivery] = useState<Record<number, "sending" | "failed" | "unknown" | "cancelled" | UploadRejection | undefined>>({});
  const [replies, setReplies] = useState<Record<number, (Message & { selectedQuote?: ReplyQuote }) | undefined>>({});
  const [attachments, setAttachments] = useState<Record<number, { kind: "document" | "video" | "photo"; file: File; options?: MediaSendOptions } | undefined>>({});
  const [fileErrors, setFileErrors] = useState<Record<number, string | undefined>>({});
  const photoInput = useRef<HTMLInputElement>(null);
  const topicInput = useRef<HTMLTextAreaElement>(null);
  const [uploads, setUploads] = useState<Record<number, { bytes: number; total: number; canCancel: boolean } | undefined>>({});
  const documentInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const uploadControls = useRef(new Map<number, { controller: AbortController; canCancel: boolean }>());
  useEffect(() => {
    const controls = uploadControls.current;
    return () => { for (const control of controls.values()) if (control.canCancel) control.controller.abort(); };
  }, []);
  const [sent, setSent] = useState<Record<number, Message[]>>({});
  const sending = useRef(new Set<number>());
  const [selected, setSelected] = useState<ForumTopic>();
  const [searchText, setSearchText] = useState("");
  const [searchRequest, setSearchRequest] = useState<{ query: string }>();
  const query = searchRequest?.query ?? "";
  const [results, setResults] = useState<{ query: string; topics: ForumTopic[] | null }>();
  useEffect(() => {
    if (!query || loadTopicPage) return;
    let current = true;
    void loadForumTopics(chatId, query).then(
      (topics) => { if (current) setResults({ query, topics }); },
      () => { if (current) setResults({ query, topics: null }); },
    );
    return () => { current = false; };
  }, [chatId, searchRequest, query, loadForumTopics, loadTopicPage]);

  const [pageState, setPageState] = useState<{ query: string; page: ForumTopicPage | null }>();
  const [pageRequest, setPageRequest] = useState<{ query: string; cursor: NonNullable<ForumTopicPage["next"]> }>();
  const [pageError, setPageError] = useState(false);
  const page = pageState?.query === query ? pageState.page : undefined;
  useEffect(() => {
    if (!loadTopicPage) return;
    let current = true;
    const cursor = pageRequest?.query === query ? pageRequest.cursor : undefined;
    void loadTopicPage(chatId, query, cursor).then((result) => {
      if (!current) return;
      if (!result && cursor) {
        setPageError(true);
        return;
      }
      setPageState((previous) => {
        if (!cursor || !result) return { query, page: result };
        const rows = new Map(previous?.page?.topics.map((topic) => [topic.id, topic]));
        for (const topic of result.topics) rows.set(topic.id, topic);
        return { query, page: { topics: [...rows.values()], next: result.next } };
      });
    }, () => {
      if (current) {
        if (!cursor) setPageState({ query, page: null });
        else setPageError(true);
      }
    });
    return () => { current = false; };
  }, [chatId, loadTopicPage, pageRequest, query, searchRequest]);

  const [changedTopics, setChangedTopics] = useState<ForumTopic[]>([]);
  const found = loadTopicPage ? (page === null ? null : page?.topics ?? (!query ? topics : undefined))
    : query ? results?.query === query ? results.topics : undefined : topics;
  const displayed = found?.map((topic) => changedTopics.find(({ id }) => id === topic.id) ?? topic);
  if (displayed && !query) displayed.unshift(...changedTopics.filter((topic) => !displayed.some(({ id }) => id === topic.id)));
  function applyTopic(topic: ForumTopic) {
    setChangedTopics((previous) => [...previous.filter(({ id }) => id !== topic.id), topic]);
    setSelected(topic);
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setResults(undefined);
    setPageState(undefined);
    setPageRequest(undefined);
    setPageError(false);
    setSearchRequest({ query: searchText.trim() });
  }

  function acceptSend(topic: ForumTopic, text: string, message: Message, scheduled = false) {
    if (!scheduled) setSent((previous) => ({ ...previous, [topic.id]: [...(previous[topic.id] ?? []), message] }));
    setDrafts((previous) => previous[topic.id]?.trim() === text ? { ...previous, [topic.id]: "" } : previous);
    formatting.clearSent(String(topic.id), text);
    setLinkPreviews((previous) => ({ ...previous, [topic.id]: undefined }));
    setAttachments((previous) => ({ ...previous, [topic.id]: undefined }));
    setReplies((previous) => ({ ...previous, [topic.id]: undefined }));
    setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
  }

  async function sendWithOptions(topic: ForumTopic, options: TopicDelivery): Promise<SendResult> {
    const text = drafts[topic.id]?.trim();
    const reply = replies[topic.id];
    if (!sendTopicText || !text || attachments[topic.id] || sending.current.has(topic.id)
      || (reply && deletedIds?.has(reply.id))) return { state: "failed" };
    sending.current.add(topic.id);
    setDelivery((previous) => ({ ...previous, [topic.id]: "sending" }));
    try {
      const styles = formatting.deliveryStyles;
      return await sendTopicText(chatId, { id: topic.id, name: topic.name }, text, reply?.id,
        styles.length ? styles : undefined, reply?.selectedQuote,
        linkPreviews[topic.id] && hasWebLink(text) ? { ...options, ...linkPreviewDelivery(linkPreviews[topic.id], text) } : options);
    } finally {
      sending.current.delete(topic.id);
      setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
    }
  }

  async function send(event: FormEvent, topic: ForumTopic) {
    event.preventDefault();
    const text = drafts[topic.id]?.trim() ?? "";
    const attachment = attachments[topic.id];
    const reply = replies[topic.id];
    if (sending.current.has(topic.id) || (reply && deletedIds?.has(reply.id))
      || (attachment ? !(attachment.kind === "photo" ? sendPhoto : sendDocument) || text.length > 1024 : !text || !sendTopicText)) return;
    sending.current.add(topic.id);
    setDelivery((previous) => ({ ...previous, [topic.id]: "sending" }));
    setFileErrors((previous) => ({ ...previous, [topic.id]: undefined }));
    try {
      const target = { id: topic.id, name: topic.name };
      let result: SendResult | { state: "cancelled" };
      if (attachment?.kind === "photo" && sendPhoto) {
        let base64: string;
        try { base64 = await preparePhoto(attachment.file); }
        catch {
          setFileErrors((previous) => ({ ...previous, [topic.id]: "Could not prepare this photo." }));
          setDelivery((previous) => ({ ...previous, [topic.id]: undefined }));
          return;
        }
        result = attachment.options
          ? await sendPhoto(chatId, text, base64, target, reply?.id, attachment.options)
          : await sendPhoto(chatId, text, base64, target, ...(reply ? [reply.id] as const : []));
      } else if (attachment && attachment.kind !== "photo" && sendDocument) {
        const { file } = attachment;
        const control = { controller: new AbortController(), canCancel: true };
        uploadControls.current.set(topic.id, control);
        setUploads((previous) => ({ ...previous, [topic.id]: { bytes: 0, total: file.size, canCancel: true } }));
        const progress = (bytes: number, canCancel = true) => {
          control.canCancel = canCancel && !control.controller.signal.aborted;
          setUploads((previous) => ({ ...previous, [topic.id]: { bytes, total: file.size, canCancel: control.canCancel } }));
        };
        const args = [chatId, file, text, progress, control.controller.signal, target] as const;
        result = await (attachment.kind === "video" ? sendDocument(...args, reply?.id, true, ...(attachment.options ? [attachment.options] as const : []))
          : reply ? sendDocument(...args, reply.id) : sendDocument(...args));
      } else if (sendTopicText) {
        const styles = formatting.deliveryStyles;
        result = linkPreviews[topic.id] && hasWebLink(text)
          ? await sendTopicText(chatId, target, text, reply?.id, styles.length ? styles : undefined, reply?.selectedQuote, linkPreviewDelivery(linkPreviews[topic.id], text))
          : await (reply?.selectedQuote ? sendTopicText(chatId, target, text, reply.id, styles.length ? styles : undefined, reply.selectedQuote)
          : styles.length ? sendTopicText(chatId, target, text, reply?.id, styles)
          : reply ? sendTopicText(chatId, target, text, reply.id) : sendTopicText(chatId, target, text));
      } else {
        return;
      }
      if (result.state === "sent") {
        acceptSend(topic, text, result.message);
      } else {
        const status = result.state === "failed" ? result.uploadRejection ?? "failed" : result.state;
        setDelivery((previous) => ({ ...previous, [topic.id]: status }));
      }
    } catch {
      setDelivery((previous) => ({ ...previous, [topic.id]: "unknown" }));
    } finally {
      sending.current.delete(topic.id);
      uploadControls.current.delete(topic.id);
      setUploads((previous) => ({ ...previous, [topic.id]: undefined }));
    }
  }

  function chooseAttachment(file: File | undefined, topicId: number, kind: "photo" | "document" | "video") {
    if (!file || replies[topicId]?.selectedQuote || sending.current.has(topicId)) return;
    const valid = file.size > 0 && (kind === "photo"
      ? isPhotoMimeType(file.type) && file.size <= maxOriginalPhotoBytes : file.size <= maxTelegramUploadBytes && (kind !== "video" || /\.mp4$/i.test(file.name)));
    setFileErrors((previous) => ({ ...previous, [topicId]: valid ? undefined : kind === "photo"
      ? "Choose a non-empty JPEG, PNG, or WebP photo up to 64 MiB." : kind === "video" ? "Choose a non-empty MP4 video up to 4000 MiB." : "Choose a non-empty document up to 4000 MiB." }));
    if (valid) setAttachments((previous) => ({ ...previous, [topicId]: { kind, file } }));
  }

  const selectedId = selected?.id;
  const topicDraft = selectedId === undefined ? "" : drafts[selectedId] ?? "";
  const formatting = useDraftFormatting(String(selectedId ?? ""), topicDraft, topicInput);
  const savedDraft = selected?.draft;
  const attachment = selectedId === undefined ? undefined : attachments[selectedId];
  const upload = selectedId === undefined ? undefined : uploads[selectedId];
  const reply = selectedId === undefined ? undefined : replies[selectedId];
  const replyDeleted = reply && deletedIds?.has(reply.id);
  const topicMediaAvailable = !!mediaComposer && !!mediaPermissions && (mediaPermissions.photos || mediaPermissions.voice || mediaPermissions.videoNote || mediaPermissions.otherMedia);

  return <section className="mtg-conversation-search mtg-forum" data-topic-open={!!selected} aria-label="Forum topics">
    {selected ? <TopicHistory key={selected.id} chatId={chatId} chat={chat} loadAvatar={loadAvatar} loadMessageLink={loadMessageLink} topic={selected} liveRevision={liveRevision} loadTopicHistory={loadTopicHistory}
      loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll} messageActions={messageActions} deletedIds={deletedIds} sent={sent[selected.id] ?? []}
      replaceSent={(updated) => setSent((previous) => ({ ...previous,
        [selected.id]: (previous[selected.id] ?? []).map((item) => item.id === updated.id ? updated : item),
      }))}
      back={() => setSelected(undefined)}
      chooseReply={(sendTopicText || sendPhoto || sendDocument) && delivery[selected.id] !== "sending"
        ? (message) => setReplies((previous) => ({ ...previous, [selected.id]: message })) : undefined}
      actions={<>
        <p>Chat ID {chatId} · Topic ID {selected.id}</p>
        <CopyRecipientReference key={selected.id} chatId={chatId} forumTopicId={selected.id} />
        {messageActions?.chatNotificationState && messageActions.setChatNotificationMode &&
          <ChatNotifications id={chatId} topicId={selected.id} chatNotificationState={messageActions.chatNotificationState}
            setChatNotificationSound={messageActions.setChatNotificationSound} setChatNotificationMode={messageActions.setChatNotificationMode} setChatNotificationOverride={messageActions.setChatNotificationOverride} />}
        {manageTopic && <TopicControls key={selected.id} chatId={chatId} topic={selected} manage={manageTopic} onChange={applyTopic} />}
      </>}
      composer={(sendTopicText || sendDocument || sendPhoto || sendPoll || topicMediaAvailable) && <div>
        {!selected.closed && !replyDeleted && !attachment && delivery[selected.id] !== "sending" && topicMediaAvailable
          && <MediaComposer key={`${selected.id}:${reply?.id ?? ""}`}
            actions={reply ? mediaComposer(chatId, { id: selected.id, name: selected.name }, { messageId: reply.id, ...(reply.selectedQuote ? { quote: reply.selectedQuote } : {}) })
              : mediaComposer(chatId, { id: selected.id, name: selected.name })}
            onSent={reply && (() => setReplies((previous) => previous[selected.id] === reply
              ? { ...previous, [selected.id]: undefined } : previous))} {...mediaPermissions} />}
        {sendPoll && <PollComposer key={selected.id} chatId={chatId} topic={{ id: selected.id, name: selected.name }} send={sendPoll} />}
        {reply && <div className="mtg-reply-preview">
          <div><strong>{replyDeleted ? "Original message was deleted" : `Replying to ${reply.author}`}</strong>
            {!replyDeleted && <p>{reply.selectedQuote?.text ?? previewMessageText(reply)}</p>}
            {!replyDeleted && !attachment && sendTopicText && reply.canQuote &&
              <SelectReplyQuote key={reply.id} text={reply.text} quote={reply.selectedQuote}
                disabled={delivery[selected.id] === "sending"} change={(selectedQuote) =>
                  setReplies((previous) => ({ ...previous, [selected.id]: { ...reply, selectedQuote } }))} />}
          </div>
          <button type="button" className="mtg-action" disabled={delivery[selected.id] === "sending"}
            onClick={() => setReplies((previous) => ({ ...previous, [selected.id]: undefined }))}>Cancel reply</button>
        </div>}
        {attachment && <div className="mtg-reply-preview"><div><bdi>{attachment.file.name}</bdi>
          {attachment.kind !== "document" && <MediaSendControls kind={attachment.kind} options={attachment.options} hasCaption={!!topicDraft.trim()}
            disabled={delivery[selected.id] === "sending"} change={(options) =>
              setAttachments((previous) => previous[selected.id] === attachment
                ? { ...previous, [selected.id]: { ...attachment, options } } : previous)} />}
          </div>
          <button type="button" className="mtg-action" disabled={delivery[selected.id] === "sending"}
            onClick={() => setAttachments((previous) => ({ ...previous, [selected.id]: undefined }))}>Remove {attachment.kind}</button>
        </div>}
        {upload && <div className="mtg-send-status">
          <progress aria-label="Topic document upload to BB" max={upload.total} value={upload.bytes} />
          {upload.bytes === upload.total && <span> Waiting for Telegram.</span>}
          {upload.canCancel && <button type="button" className="mtg-action" onClick={() => {
            const control = uploadControls.current.get(selected.id);
            if (!control?.canCancel) return;
            control.canCancel = false;
            control.controller.abort();
            setUploads((previous) => ({ ...previous, [selected.id]: { ...upload, canCancel: false } }));
          }}>Cancel upload</button>}
        </div>}
        {loadTopicDraft && saveTopicDraft && sendTopicText && !attachment && !reply &&
          <TopicDraftSync key={selected.id} chatId={chatId} topicId={selected.id} load={loadTopicDraft} save={saveTopicDraft}
            text={topicDraft} edited={drafts[selected.id] !== undefined}
            busy={delivery[selected.id] === "sending" || formatting.deliveryStyles.length > 0 || !!linkPreviews[selected.id]}
            useDraft={(text) => { setDrafts((previous) => ({ ...previous, [selected.id]: text })); topicInput.current?.focus(); }} />}
        {!(loadTopicDraft && saveTopicDraft) && savedDraft && sendTopicText && drafts[selected.id] === undefined && !attachment && !reply &&
          <button type="button" className="mtg-action" onClick={() => {
            setDrafts((previous) => previous[selected.id] === undefined ? { ...previous, [selected.id]: savedDraft } : previous);
          }}>Use Telegram draft</button>}
        {sendTopicText && scheduleActions && !attachment &&
          <ScheduledMessages key={selected.id} chatId={chatId} topicId={selected.id} liveRevision={liveRevision ?? 0}
            mediaLoaders={{ loadPhoto, loadMedia, loadVideoStream }}
            draft={topicDraft} canSend={!replyDeleted && delivery[selected.id] !== "sending"} {...scheduleActions}
            send={(options) => sendWithOptions(selected, options)}
            accepted={(text, result, scheduled) => acceptSend(selected, text, result.message, scheduled)} />}
        {sendTopicText && !attachment && hasWebLink(topicDraft) && <LinkPreviewControls choice={linkPreviews[selected.id]} text={topicDraft}
          disabled={delivery[selected.id] === "sending"}
          change={(placement) => setLinkPreviews((previous) => ({ ...previous, [selected.id]: placement }))} />}
        {sendTopicText && !attachment && <DraftFormatControls formatting={formatting} busy={delivery[selected.id] === "sending"} />}
        <form className="mtg-composer" onSubmit={(event) => void send(event, selected)} onPaste={(event) => {
          if (!sendPhoto || reply?.selectedQuote || sending.current.has(selected.id)) return;
          const photo = Array.from(event.clipboardData.files).find((file) => isPhotoMimeType(file.type));
          if (!photo) return;
          event.preventDefault();
          chooseAttachment(photo, selected.id, "photo");
        }}>
        {sendPhoto && <>
          <input ref={photoInput} type="file" aria-label="Choose a topic photo" accept={photoAccept} hidden
            disabled={delivery[selected.id] === "sending"}
            onChange={(event) => {
              chooseAttachment(event.currentTarget.files?.[0], selected.id, "photo");
              event.currentTarget.value = "";
            }} />
          <button type="button" aria-label="Attach topic photo" title="Attach photo" disabled={!!reply?.selectedQuote || delivery[selected.id] === "sending"}
            onClick={() => photoInput.current?.click()}><Camera size={17} aria-hidden="true" /></button>
        </>}
        {sendDocument && allowVideoAttachment && <>
          <input ref={videoInput} type="file" aria-label="Choose a topic video" accept=".mp4,video/mp4" hidden
            onChange={(event) => {
              chooseAttachment(event.currentTarget.files?.[0], selected.id, "video");
              event.currentTarget.value = "";
            }} />
          <button type="button" className="mtg-action" disabled={!!reply?.selectedQuote || delivery[selected.id] === "sending"}
            onClick={() => videoInput.current?.click()}>Attach topic video</button>
        </>}
        {sendDocument && allowDocumentAttachment && <>
          <input ref={documentInput} type="file" aria-label="Choose a topic document" hidden
            disabled={delivery[selected.id] === "sending"}
            onChange={(event) => {
              chooseAttachment(event.currentTarget.files?.[0], selected.id, "document");
              event.currentTarget.value = "";
            }} />
          <button type="button" aria-label="Attach topic document" title="Attach document" disabled={!!reply?.selectedQuote || delivery[selected.id] === "sending"}
            onClick={() => documentInput.current?.click()}><Paperclip size={17} aria-hidden="true" /></button>
        </>}
        {sendTopicText && !attachment && <DraftFormatButton formatting={formatting} busy={delivery[selected.id] === "sending"} />}
        {(sendTopicText || sendPhoto || attachment) && <textarea ref={topicInput} rows={1} onKeyDown={submitComposerOnEnter} aria-label={attachment ? "Write a topic attachment caption" : !sendTopicText ? "Paste a topic photo or write a caption" : "Write a topic message"}
          placeholder={attachment ? "Write an attachment caption" : !sendTopicText ? "Paste a photo or write a caption" : "Write a topic message"} maxLength={attachment ? 1024 : 4096}
          value={topicDraft} disabled={delivery[selected.id] === "sending"}
          onSelect={(event) => formatting.select(event.currentTarget)}
          onChange={(event) => {
            const text = event.currentTarget.value;
            formatting.change(text);
            setDrafts((previous) => ({ ...previous, [selected.id]: text }));
          }} />}
        <button type="submit" className="mtg-action"
          disabled={!!replyDeleted || (attachment ? !(attachment.kind === "photo" ? sendPhoto : sendDocument) || (drafts[selected.id]?.trim().length ?? 0) > 1024
            : !sendTopicText || !drafts[selected.id]?.trim()) || delivery[selected.id] === "sending"}>Send to topic</button>
        </form>
        {fileErrors[selected.id] && <p role="alert">{fileErrors[selected.id]}</p>}
        {delivery[selected.id] === "failed" && <p role="alert">Telegram rejected the message. Your draft is still here.</p>}
        {delivery[selected.id] === "unknown" && <p role="alert">Telegram did not confirm delivery. Check the topic before retrying.</p>}
        {delivery[selected.id] === "cancelled" && <p role="status">Upload cancelled. Your draft is still here.</p>}
        {delivery[selected.id] === "legacy_tdlib" && <p role="alert">Update TDLib to send documents this large.</p>}
        {delivery[selected.id] === "premium_required" && <p role="alert">Telegram Premium is required to send documents over 2000 MiB.</p>}
        {delivery[selected.id] === "file_too_large" && <p role="alert">Telegram supports uploads up to 4000 MiB.</p>}
        {delivery[selected.id] === "reply_unavailable" && <p role="alert">The original message is unavailable. Your draft is still here.</p>}
      </div>} />
      : <>
        <form className="mtg-composer" onSubmit={search}>
          <input autoFocus type="search" maxLength={128} aria-label="Find a topic" placeholder="Find a topic"
            value={searchText} onChange={(event) => setSearchText(event.target.value)} />
          <button type="submit" className="mtg-action">Find</button>
          <button type="button" className="mtg-action" onClick={close}>Back to conversation</button>
        </form>
        {manageTopic && <TopicControls chatId={chatId} manage={manageTopic} onChange={applyTopic} />}
        {displayed === undefined && <p role="status">Searching topics…</p>}
        {displayed === null && <p role="alert">Could not load Telegram topics.</p>}
        {displayed?.length === 0 && <p role="status">No matching topics</p>}
        {!!displayed?.length && <ul>{displayed.map((topic) => <li key={topic.id}>
          <button type="button" className="mtg-action" onClick={() => setSelected(topic)}><bdi>{topic.name}</bdi>{topic.closed && " · Closed"}{topic.pinned && " · Pinned"}</button>
        </li>)}</ul>}
        {page?.next && <button type="button" className="mtg-action"
          disabled={pageRequest?.cursor === page.next && !pageError}
          onClick={() => { if (page.next) { setPageError(false); setPageRequest({ query, cursor: page.next }); } }}>
          {pageError ? "Retry more topics" : "Load more topics"}
        </button>}
      </>}
  </section>;
}

function TopicControls({ chatId, topic, manage, onChange }: {
  chatId: string;
  topic?: ForumTopic;
  manage: ManageForumTopic;
  onChange: (topic: ForumTopic) => void;
}) {
  const [name, setName] = useState(topic?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function run(action: Parameters<ManageForumTopic>[1]) {
    setBusy(true);
    setError(false);
    try {
      const result = await manage(chatId, action);
      setName(result.name);
      onChange(result);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <details>
    <summary>{topic ? "Topic settings" : "New topic"}</summary>
    <form className="mtg-composer" onSubmit={(event) => {
      event.preventDefault();
      const title = name.trim();
      if (!busy && title) void run(topic ? { kind: "rename", topic: topic.id, name: title } : { kind: "create", name: title });
    }}>
      <input aria-label="Topic name" maxLength={128} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      <button className="mtg-action" type="submit" disabled={busy || !name.trim() || name.trim() === topic?.name}>{topic ? "Rename topic" : "Create topic"}</button>
    </form>
    {topic && <button className="mtg-action" type="button" disabled={busy} onClick={() =>
      void run({ kind: "close", topic: topic.id, closed: !topic.closed })}>{topic.closed ? "Reopen topic" : "Close topic"}</button>}
    {topic && <button className="mtg-action" type="button" disabled={busy} onClick={() =>
      void run({ kind: "pin", topic: topic.id, pinned: !topic.pinned })}>{topic.pinned ? "Unpin topic" : "Pin topic"}</button>}
    {error && <p role="alert">Telegram could not apply this change. Check your topic permissions.</p>}
  </details>;
}

function TopicHistory({ chatId, chat, loadAvatar, loadMessageLink, topic, liveRevision, loadTopicHistory, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, messageActions, deletedIds, sent, replaceSent, actions, composer, chooseReply, back }: {
  chatId: string;
  chat?: Chat;
  loadAvatar?: AvatarLoader;
  loadMessageLink?: MessageLinkLoader;
  topic: ForumTopic;
  liveRevision?: number;
  loadTopicHistory: ForumActions["loadTopicHistory"];
  loadPhoto: ComponentProps<typeof MessageContent>["loadPhoto"];
  loadMedia?: ComponentProps<typeof MessageContent>["loadMedia"];
  loadVideoStream?: ComponentProps<typeof MessageContent>["loadVideoStream"];
  transcribeVoice?: ComponentProps<typeof MessageContent>["transcribeVoice"];
  saveDocument: ComponentProps<typeof MessageContent>["saveDocument"];
  forwardActions?: ComponentProps<typeof MessageContent>["forwardActions"];
  reactionActions?: ComponentProps<typeof MessageContent>["reactionActions"];
  stopPoll?: ComponentProps<typeof MessageContent>["stopPoll"];
  voteInPoll?: ComponentProps<typeof MessageContent>["voteInPoll"];
  messageActions?: TopicMessageActions;
  deletedIds?: ReadonlySet<string>;
  sent: readonly Message[];
  replaceSent: (message: Message) => void;
  actions: ReactNode;
  composer: ReactNode;
  chooseReply?: (message: Message) => void;
  back: () => void;
}) {
  const [searchMode, setSearchMode] = useState<"pinned" | "search" | "author" | "date">();
  const [selectedDay, setSelectedDay] = useState<string>();
  const dateTrigger = useRef<HTMLButtonElement>(null);
  const [author, setAuthor] = useState<AuthorFilter>();
  const [authorRevision, setAuthorRevision] = useState(0);
  const authorTrigger = useRef<HTMLButtonElement>(null);
  const pinnedTrigger = useRef<HTMLButtonElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [original, setOriginal] = useState<string>();
  const originalTrigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<EditDraft>();
  const [page, setPage] = useState<HistoryPage>();
  const shownPage = useRef<HistoryPage>(undefined);
  const seenRevision = useRef(liveRevision);
  const history = useRef<HTMLOListElement>(null);
  const scrolling = useRef<{ mode: "keep" | "prepend"; top: number; height: number; row?: HTMLElement; rowTop?: number } | undefined>(undefined);
  const lastHistoryTop = useRef(0);
  const followLatest = useRef(true);
  useLayoutEffect(() => {
    shownPage.current = page;
    const list = history.current;
    const position = scrolling.current;
    scrolling.current = undefined;
    if (!list) return;
    if (position) {
      const shift = position.row && list.contains(position.row) && position.rowTop !== undefined
        ? position.row.getBoundingClientRect().top - position.rowTop
        : position.mode === "prepend" ? list.scrollHeight - position.height : 0;
      list.scrollTop = Math.max(0, position.top + shift);
    } else if (followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
    lastHistoryTop.current = list.scrollTop;
    followLatest.current = list.scrollHeight - list.clientHeight - list.scrollTop <= 64;
  }, [page, sent.length]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<{ before?: string }>({});
  useEffect(() => {
    let current = true;
    void loadTopicHistory(chatId, topic.id, cursor.before).then((next) => {
      if (!current) return;
      const list = history.current;
      if (cursor.before && list) {
        const top = list.getBoundingClientRect().top;
        const row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"))
          .find((item) => item.getBoundingClientRect().bottom > top);
        scrolling.current = { mode: "prepend", top: list.scrollTop, height: list.scrollHeight,
          row, rowTop: row?.getBoundingClientRect().top };
      }
      setPage((previous) => {
        if (!cursor.before || !previous) return next;
        const existing = new Set(previous.messages.map(({ id }) => id));
        return { ...next, messages: [...next.messages.filter(({ id }) => !existing.has(id)), ...previous.messages] };
      });
    }, () => { if (current) setError(true); }).finally(() => { if (current) setPending(false); });
    return () => { current = false; };
  }, [chatId, cursor, loadTopicHistory, topic.id]);

  useEffect(() => {
    if (seenRevision.current === liveRevision) return;
    seenRevision.current = liveRevision;
    const previous = shownPage.current;
    if (!previous) return;
    let current = true;
    const newest = Number(previous.messages.at(-1)?.id);
    void loadTopicHistory(chatId, topic.id).then(async (page) => {
      const latest = await fillHistoryGap(page, newest, (before) => loadTopicHistory(chatId, topic.id, before), () => current);
      if (!latest || !current) return;
      const list = history.current;
      if (list && !scrolling.current && list.scrollHeight - list.clientHeight - list.scrollTop > 64) {
        scrolling.current = { mode: "keep", top: list.scrollTop, height: list.scrollHeight };
      }
      setPage((previous) => mergeLatestHistory(previous, latest));
    }).catch(() => {
      // Preserve visible topic messages on a transient refresh failure.
    });
    return () => { current = false; };
  }, [chatId, liveRevision, loadTopicHistory, topic.id]);

  function load(before?: string) {
    setPending(true);
    setError(false);
    setCursor({ before });
  }

  const before = page?.before;
  const canLoadOlderOnScroll = before && !pending && !error && !searchMode && !original;

  async function saveEdit(event: FormEvent<HTMLFormElement>, styles?: StyledRange[], removeLinkPreview?: string, placement?: CaptionPlacement) {
    event.preventDefault();
    if (!editing || editing.busy || !messageActions || deletedIds?.has(editing.message.id)) return;
    const { message, text } = editing;
    setEditing({ ...editing, busy: true, error: undefined });
    let result: SendResult;
    try {
      result = await (submitMessageEdit(chatId, message, text.trim(), messageActions, styles, removeLinkPreview, placement) ?? { state: "failed" });
    } catch { result = { state: "unknown" }; }
    if (result.state === "sent") {
      const list = history.current;
      if (list && !scrolling.current) scrolling.current = { mode: "keep", top: list.scrollTop, height: list.scrollHeight };
      setPage((previous) => previous && { ...previous, messages: previous.messages.map((item) =>
        item.id === result.message.id ? { ...item, ...result.message, photoCaption: result.message.photoCaption,
          captionAboveMedia: result.message.captionAboveMedia,
          styles: result.message.styles, links: result.message.links, linkPreview: result.message.linkPreview } : item) });
      replaceSent(result.message);
      setEditing(undefined);
    } else {
      setEditing({ ...editing, busy: false, error: result.state === "unknown"
        ? "Telegram did not confirm the edit." : "The message changed or Telegram rejected the edit." });
    }
  }

  const loaded = page?.messages ?? [];
  const ids = new Set(loaded.map(({ id }) => id));
  const displayed = [...loaded, ...sent.filter(({ id }) => !ids.has(id))].filter(({ id }) => !deletedIds?.has(id));
  const byId = new Map(displayed.map((item) => [item.id, item]));
  return <>
    <button autoFocus type="button" className="mtg-action" onClick={back}>Back to topics</button>
    <h3><bdi>{topic.name}</bdi></h3>
    {actions}
    {messageActions?.searchMessages && <>
      <button ref={searchTrigger} type="button" className="mtg-chat-search-toggle"
        aria-label="Search topic messages" aria-expanded={searchMode === "search"} onClick={() => {
          setOriginal(undefined);
          setSearchMode(searchMode === "search" ? undefined : "search");
        }}><Search size={17} aria-hidden="true" /></button>
      <button ref={pinnedTrigger} type="button" className="mtg-chat-search-toggle"
        title="Pinned topic messages" aria-label="Pinned topic messages" aria-expanded={searchMode === "pinned"}
        onClick={() => {
          setOriginal(undefined);
          setSearchMode(searchMode === "pinned" ? undefined : "pinned");
        }}><Pin size={17} aria-hidden="true" /></button>
    </>}
    {(original || searchMode) && <ConversationSearch key={original ?? (searchMode === "author" ? `author:${authorRevision}` : searchMode === "date" ? `date:${selectedDay}` : searchMode)} chatId={chatId} chat={chat} loadAvatar={loadAvatar}
      initialMessage={original} initialDay={searchMode === "date" ? selectedDay : undefined} loadAtDate={messageActions?.loadMessageAtDate} initialAuthor={searchMode === "author" ? author : undefined} initialFilter={searchMode === "pinned" ? "pinned" : undefined} topicId={topic.id} search={messageActions?.searchMessages} loadContext={messageActions?.loadMessageContext} loadContextPage={messageActions?.loadMessageContextPage}
      markActivityRead={messageActions?.markActivityRead} mediaCollection={messageActions?.mediaCollection}
      loadMessageLink={loadMessageLink} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll}
      deletedIds={deletedIds} close={() => {
        setOriginal(undefined);
        setSearchMode(undefined);
        (original ? originalTrigger : searchMode === "author" ? authorTrigger : searchMode === "pinned" ? pinnedTrigger : searchMode === "date" ? dateTrigger : searchTrigger).current?.focus();
      }} />}
    <ol className="mtg-history" ref={history} aria-label="Topic messages" tabIndex={0}
      onScroll={(event) => {
        const list = event.currentTarget;
        if (canLoadOlderOnScroll && list.scrollTop <= 96 && list.scrollTop < lastHistoryTop.current) load(before);
        lastHistoryTop.current = list.scrollTop;
        followLatest.current = list.scrollHeight - list.clientHeight - list.scrollTop <= 64;
      }}
      onWheel={(event) => {
        if (canLoadOlderOnScroll && event.deltaY < 0 && event.currentTarget.scrollTop <= 0) load(before);
      }}>
      {before && <li className="mtg-history-start">
        {!pending && !error && <button type="button" className="mtg-action"
          onClick={() => load(before)}>Load earlier topic messages</button>}
      </li>}
      {pending && <li role="status">Loading topic history…</li>}
      {error && <li role="alert">Could not load topic history. <button type="button" onClick={() => load(cursor.before)}>Retry</button></li>}
      {page && !pending && !displayed.length && <li role="status">No messages</li>}
      {groupMessageTimeline(displayed).flatMap(({ day, group }) => {
        const albumCaption = sharedAlbumCaption(group);
        const albumPhotos = group.length > 1
          ? group.filter((entry) => entry.hasPhoto).map(({ id, photoSpoiler, canSavePhoto }) => ({ id, spoiler: photoSpoiler, canSave: canSavePhoto }))
          : undefined;
        const rows = group.map((item) => item.service && !item.retained
          ? <ServiceMessageRow key={item.id} message={item}
            openPinned={messageActions?.loadMessageContext && !deletedIds?.has(item.pinnedTargetId ?? "")
              ? (id, event) => { originalTrigger.current = event.currentTarget; setSearchMode(undefined); setOriginal(id); }
              : undefined} /> : <li key={item.id} data-message-id={item.id} data-album-id={item.albumId} className={`mtg-message${item.outgoing ? " mtg-outgoing" : ""}`}>
          <div className="mtg-bubble">
            {item.replyTo && <blockquote className="mtg-reply-quote">
              {deletedIds?.has(item.replyTo) ? "Original message unavailable"
                : messageActions?.loadMessageContext
                  ? <button type="button" className="mtg-open-reply" aria-label="Open original message"
                    onClick={(event) => { originalTrigger.current = event.currentTarget; setSearchMode(undefined); setOriginal(item.replyTo); }}>
                    {item.replyQuote ?? previewMessageText(byId.get(item.replyTo)) ?? "Earlier message"}
                  </button>
                  : item.replyQuote ?? previewMessageText(byId.get(item.replyTo)) ?? "Earlier message"}
            </blockquote>}
            {item.author && <MessageAuthor message={item} chat={chat} load={loadAvatar}
              search={messageActions?.searchMessages && !item.retained && item.sender ? (button) => {
                authorTrigger.current = button;
                setAuthor({ sender: item.sender!, name: item.author });
                setAuthorRevision((revision) => revision + 1);
                setOriginal(undefined);
                setSearchMode("author");
              } : undefined} />}
            <div className="mtg-message-time"><MessageTimestamp message={item} /></div>
            <MessageContent chatId={chatId} message={item} hideCaption={albumCaption?.message === item} albumPhotos={albumPhotos} mediaCollection={messageActions?.mediaCollection} loadPhoto={loadPhoto} loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} saveDocument={saveDocument} forwardActions={forwardActions} reactionActions={reactionActions} stopPoll={stopPoll} voteInPoll={voteInPoll} />
            <div key="viewer-slot" className="mtg-message-viewer-slot">
              {messageActions?.messageViewers && item.outgoing && !item.retained && !item.pendingDelivery && /^[1-9]\d{0,15}$/.test(item.id)
                && <MessageViewers key={`${chatId}:${item.id}`} chatId={chatId} messageId={item.id} load={messageActions.messageViewers} />}
            </div>
            {!item.pendingDelivery && /^[1-9]\d{0,15}$/.test(item.id) && <>
              <CopyMessageReference chatId={chatId} messageId={item.id} forumTopicId={topic.id} />
              {loadMessageLink && <CopyTelegramLink chatId={chatId} messageId={item.id} load={loadMessageLink} />}
              {messageActions?.pinStatus && messageActions.setMessagePinned &&
                <MessagePin chatId={chatId} messageId={item.id} inTopic pinStatus={messageActions.pinStatus}
                  setMessagePinned={messageActions.setMessagePinned} />}
              {messageActions?.deletionOptions && messageActions.deleteMessage &&
                <MessageDeletion chatId={chatId} messageId={item.id} deletionOptions={messageActions.deletionOptions}
                  deleteMessage={messageActions.deleteMessage} />}
              {(messageActions?.editText && item.editable || messageActions?.editCaption && item.editableCaption) && <button type="button" className="mtg-reply-action"
                aria-label={item.editableCaption ? "Edit caption" : "Edit message"} title="Edit" disabled={editing?.busy}
                onClick={() => setEditing({ message: item, text: editableMessageText(item), busy: false })}><Pencil size={15} aria-hidden="true" /></button>}
              {chooseReply && <button type="button" className="mtg-reply-action" onClick={() => chooseReply(item)}>Reply</button>}
            </>}
          </div>
        </li>);
        const first = group[0]!;
        const entry = first.albumId ? [<MessageAlbum key={`album:${first.albumId}:${first.id}`} first={first} caption={albumCaption}>{rows}</MessageAlbum>] : rows;
        if (!day) return entry;
        const date = first.timestamp && localDateInputValue(first.timestamp);
        return [<li key={`day:${first.id}`} className="mtg-date mtg-history-day">
          {date && messageActions?.loadMessageAtDate && messageActions.loadMessageContext
            ? <button type="button" className="mtg-history-day-jump" aria-label={`Jump to date from ${day}`}
              onClick={(event) => {
                dateTrigger.current = event.currentTarget;
                setOriginal(undefined);
                setSelectedDay(date);
                setSearchMode("date");
              }}>{day}</button>
            : day}
        </li>, ...entry];
      })}
    </ol>
    {editing && !deletedIds?.has(editing.message.id) && <MessageEdit key={editing.message.id} draft={editing}
      change={(text) => setEditing({ ...editing, text })} cancel={() => setEditing(undefined)} save={saveEdit} />}
    {composer}
  </>;
}
