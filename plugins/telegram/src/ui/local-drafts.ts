import { useLayoutEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import type { AttachmentReply, ChannelInboxAttachmentKind, ChannelInboxReply, CustomEmojiRange, DocumentSendOptions, MediaReply, MediaSendOptions, ReplyQuote, RichDraftRange, RichMessageDraft, StyledRange, SyncedDraft, TranslationLanguage, UploadRejection, VideoEdit } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import type { MessageLink } from "../core/message-links.ts";
import type { AttachmentDeliveryDraft } from "./attachment-delivery.tsx";
import type { LinkPreviewChoice } from "./link-preview-controls.tsx";
import { createHistoryView } from "./history-scroll.ts";

export function createDraftRecord<T>() {
  let snapshot: Record<string, T> = {};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(next: SetStateAction<Record<string, T>>) {
      const value = typeof next === "function" ? next(snapshot) : next;
      if (Object.is(value, snapshot)) return;
      snapshot = value;
      for (const listener of listeners) listener();
    },
  };
}

export type DraftRecord<T> = ReturnType<typeof createDraftRecord<T>>;

export function useDraftRecord<T>(shared?: DraftRecord<T>) {
  const [local] = useState(() => createDraftRecord<T>());
  const record = shared ?? local;
  return [useSyncExternalStore(record.subscribe, record.getSnapshot), record.update] as const;
}

export type RichComposerBlock = {
  id: number;
  kind: RichMessageDraft[number]["kind"];
  text: string;
  file?: File;
  editedPhoto?: { data: string; blob: Blob };
  videoEdit?: VideoEdit;
  existingMedia?: import("../core/contract.ts").ExistingWelcomeMedia;
  spoiler?: boolean;
  styles?: RichDraftRange[];
  links?: MessageLink[];
  customEmoji?: CustomEmojiRange[];
  formulas?: import("../core/contract.ts").RichFormulaRange[];
  headingSize?: number;
  language?: string;
  tableOptions?: import("../core/contract.ts").RichTableOptions;
  structuredTable?: import("../core/contract.ts").RichTableCell[][];
  quoteCredit?: import("../core/contract.ts").RichCaptionDraft;
  listEntries?: import("../core/contract.ts").RichFormattedListItem[];
  quoteParagraphs?: import("../core/contract.ts").RichCaptionDraft[];
  buttonRow?: import("../core/contract.ts").RichButtonRow;
  inlineButtons?: import("../core/contract.ts").DraftInlineButton[];
};

export type DraftFormatting = { text: string; ranges: StyledRange[]; links: MessageLink[]; customEmoji?: CustomEmojiRange[] };

export type InboxDraft = { text: string; file?: File; kind?: ChannelInboxAttachmentKind; album?: { files: File[]; asDocuments: boolean };
  replyTo?: ChannelInboxReply; outcome?: "failed" | "unknown"; uploadRejection?: UploadRejection };

export function createInboxDrafts() {
  return { drafts: createDraftRecord<InboxDraft>(), formatting: createDraftRecord<DraftFormatting | undefined>(),
    sending: createDraftRecord<true | undefined>() };
}

function createConversationDrafts() {
  return {
    text: createDraftRecord<string>(),
    longDraftDelivery: createDraftRecord<"sending" | "unknown" | undefined>(),
    previews: createDraftRecord<LinkPreviewChoice | undefined>(),
    formatting: createDraftRecord<DraftFormatting | undefined>(),
    rich: createDraftRecord<RichComposerBlock[]>(),
    richReplies: createDraftRecord<SpecializedDraftReply>(),
    replies: createDraftRecord<ComposerReply | undefined>(),
    attachments: createDraftRecord<DraftAttachment | undefined>(),
    attachmentDelivery: createDraftRecord<"sending" | "failed" | "unknown" | "cancelled" | "scheduled" | UploadRejection | undefined>(),
  };
}

export type ConversationDrafts = ReturnType<typeof createConversationDrafts>;

export type DraftAttachment = {
  name: string;
  options?: DocumentSendOptions;
  delivery?: AttachmentDeliveryDraft;
} & (
  | { kind: "photo"; data: string; drawnPhotoReply?: string; originalFile?: File }
  | { kind: "photo" | "document" | "video"; file: File }
);

export function originalAttachment(attachment: DraftAttachment) {
  return "data" in attachment ? attachment.originalFile : attachment.file;
}

export function textDraftAttachment(text: string): Extract<DraftAttachment, { file: File }> {
  const name = "message.txt";
  return { kind: "document", name, file: new File([text], name, { type: "text/plain;charset=utf-8" }) };
}

export type ReplyOrigin = { chatId: string; topicId?: number };
export type ComposerReply = Message & { selectedQuote?: ReplyQuote; origin?: ReplyOrigin };
export type SpecializedDraftReply = { reply?: ComposerReply };

export function composerMediaReply(reply?: ComposerReply): MediaReply | undefined {
  if (!reply) return;
  return {
    messageId: reply.id,
    ...(reply.selectedQuote ? { quote: reply.selectedQuote } : {}),
    ...(reply.origin ? { externalReplyChatId: reply.origin.chatId } : {}),
  };
}

export function attachmentReply(reply?: ComposerReply): AttachmentReply | undefined {
  return reply?.origin || reply?.selectedQuote ? composerMediaReply(reply) : reply?.id;
}

export function drawnPhotoReplyId(attachment?: DraftAttachment) {
  return attachment && "data" in attachment ? attachment.drawnPhotoReply : undefined;
}

export function photoAttachmentReply(attachment: DraftAttachment, reply?: ComposerReply): AttachmentReply | undefined | false {
  const source = drawnPhotoReplyId(attachment);
  if (!source) return attachmentReply(reply);
  if (reply?.id !== source || reply.origin || reply.selectedQuote) return false;
  return { messageId: source, drawnPhoto: true };
}

export type StashedDraft = {
  draft: SyncedDraft;
  preview?: LinkPreviewChoice;
  reply?: ComposerReply;
  attachment?: DraftAttachment;
};

type StashDestination = ReplyOrigin & {
  text: boolean;
  attachments?: Record<DraftAttachment["kind"], boolean>;
};

export type AlbumDraft = {
  documents: boolean;
  audio?: boolean;
  files: { kind: DraftAttachment["kind"] | "audio"; file: File; motion?: File; editedPhoto?: string; videoEdit?: VideoEdit; caption?: string;
    captionFormatting?: DraftFormatting }[];
  caption: SyncedDraft;
  separateCaptions?: boolean;
  options?: MediaSendOptions;
  silent: boolean;
  deliveryTime: string;
  whenOnline?: true;
  reply?: ComposerReply;
};

type FormattedDraft = { blocks: RichComposerBlock[]; silent: boolean; deliveryTime: string; reply?: ComposerReply };
export type SpecializedDraft = { kind: "album"; value: AlbumDraft } | { kind: "rich"; value: FormattedDraft };

export function hasFormattedDraft(blocks: RichComposerBlock[]) {
  return blocks.length > 1 || blocks.some((block) => block.kind !== "paragraph" || !!block.text);
}

export function useDraftStashCheck(snapshot: string, payload?: unknown, reply?: ComposerReply) {
  const attempt = useRef(0);
  useLayoutEffect(() => () => { attempt.current++; }, [snapshot, payload, reply]);
  return () => {
    const current = ++attempt.current;
    return () => attempt.current === current;
  };
}

function externalReplyOrigin(saved: { value: { reply?: ComposerReply } } & ReplyOrigin, destination: ReplyOrigin) {
  if (!saved.value.reply) return;
  const source = saved.value.reply.origin ?? { chatId: saved.chatId, topicId: saved.topicId };
  if (source.chatId !== destination.chatId || source.topicId !== destination.topicId) return source;
}

function restoreDraftReply<T extends { reply?: ComposerReply }>(value: T, origin?: ReplyOrigin): T {
  if (!value.reply) return value;
  const { origin: _, ...reply } = value.reply;
  return { ...value, reply: origin ? { ...reply, origin } : reply };
}

export function createDraftStash() {
  let saved: ({ kind: "composer"; value: StashedDraft } | SpecializedDraft) & ReplyOrigin | undefined;
  return {
    review() {
      const candidate = saved;
      return { kind: candidate?.kind, stillCurrent: () => saved === candidate };
    },
    async checkExternalReply(check: (chatId: string, messageId: string) => Promise<boolean>) {
      const candidate = saved;
      if (!candidate?.value.reply) return;
      const { id, origin } = candidate.value.reply;
      if (await check(origin?.chatId ?? candidate.chatId, id)) return () => saved === candidate;
    },
    exchange(current: StashedDraft, destination: StashDestination, verifiedExternal?: () => boolean): StashedDraft | "differentConversation" | "unsupportedDraft" | "album" | "rich" | undefined {
      const { chatId, topicId } = destination;
      if (saved && saved.kind !== "composer") return saved.kind;
      const external = saved && externalReplyOrigin(saved, destination);
      if (saved && (saved.value.attachment
        ? !destination.attachments?.[saved.value.attachment.kind]
        : !destination.text)) return "unsupportedDraft";
      if (external && !verifiedExternal?.()) return "differentConversation";
      const hasDraft = !!(current.draft.text.length || current.reply || current.attachment);
      if (!hasDraft && !saved) return;
      const restored = saved?.value ?? { draft: { text: "" } };
      saved = hasDraft ? { kind: "composer", value: current, chatId, topicId } : undefined;
      return restoreDraftReply(restored, external);
    },
    exchangeSpecialized(current: SpecializedDraft, destination: ReplyOrigin,
      validate: (restored: SpecializedDraft) => "unsupported" | "occupied" | undefined, verifiedExternal?: () => boolean) {
      if (saved?.kind === "composer") return { state: "composer" } as const;
      const problem = saved && validate(saved);
      if (problem) return { state: problem };
      const external = saved && externalReplyOrigin(saved, destination);
      if (external && !verifiedExternal?.()) return { state: "differentConversation" } as const;
      const hasDraft = current.kind === "album" ? !!(current.value.files.length || current.value.caption.text.length)
        : hasFormattedDraft(current.value.blocks);
      if (!hasDraft && !saved) return { state: "empty" } as const;
      const restored: SpecializedDraft | undefined = saved?.kind === "album"
        ? { kind: "album", value: restoreDraftReply(saved.value, external) }
        : saved && { kind: "rich", value: restoreDraftReply(saved.value, external) };
      saved = hasDraft ? { ...destination, ...current } : undefined;
      return { state: "exchanged", restored } as const;
    },
  };
}

export type DraftStash = ReturnType<typeof createDraftStash>;

export function createAccountDrafts() {
  const forums = new Map<string, ConversationDrafts>();
  const inboxes = new Map<string, ReturnType<typeof createInboxDrafts>>();
  return {
    chats: createConversationDrafts(),
    history: createHistoryView(),
    stash: createDraftStash(),
    translation: createDraftRecord<{ language?: TranslationLanguage; enabled: boolean }>(),
    inbox(inboxId: string) {
      let drafts = inboxes.get(inboxId);
      if (!drafts) {
        drafts = createInboxDrafts();
        inboxes.set(inboxId, drafts);
      }
      return drafts;
    },
    forum(chatId: string) {
      let drafts = forums.get(chatId);
      if (!drafts) {
        drafts = createConversationDrafts();
        forums.set(chatId, drafts);
      }
      return drafts;
    },
  };
}

export type AccountDrafts = ReturnType<typeof createAccountDrafts>;
