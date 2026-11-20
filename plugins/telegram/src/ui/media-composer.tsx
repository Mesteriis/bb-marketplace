import { useTelegramLocale } from "./i18n/index.tsx";
import { Camera, ContactRound, FileAudio, FileImage, Files, FileText, Images, ListChecks, MapPin, Mic, Music, Sticker, type LucideIcon } from "lucide-react";
import { ComposerActionEntry } from "./composer-actions.tsx";
import type { DispatchRecordingActivity } from "./recording-activity.ts";
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { isAudioAttachmentName, isChatAnimationAttachmentName, isVideoAttachmentName, locationPoint, maxTelegramUploadBytes, maxVideoNoteBytes, videoAttachmentAccept, type LocationPoint, type ContactDraft, type ChecklistAvailability, type ChecklistDraft, maxVoiceBytes, type GifSendOptions, type AlbumSendOptions, type MediaDelivery, type MediaReply, type AttachmentSendDelivery, type AttachmentSendOptions, maxPaidAlbumStars, type MediaSendOptions, type schemas } from "../core/contract.ts";
import type { z } from "zod";
import { StickerPackDiscovery, type StickerPackDiscoveryActions } from "./sticker-pack-discovery.tsx";
import { StickerPackLibrary, type StickerPackLibraryActions } from "./sticker-pack-library.tsx";
import { StickerPackOrder, type StickerPackSummary } from "./sticker-pack-order.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { EditDraftPhoto } from "./edit-draft-photo.tsx";
import { EditDraftVideo } from "./edit-draft-video.tsx";
import { EditDraftAnimation } from "./edit-draft-animation.tsx";
import type { AnimationTrim } from "../core/contract.ts";
import { importMotionPhoto } from "./import-motion-photo.ts";
import { composerMediaReply, createDraftRecord, hasFormattedDraft, useDraftRecord, useDraftStashCheck, type AlbumDraft, type ComposerReply, type ConversationDrafts, type DraftFormatting, type DraftRecord, type DraftStash, type ReplyOrigin, type RichComposerBlock, type SpecializedDraft, type SpecializedDraftReply } from "./local-drafts.ts";
import { isStashShortcut } from "./composer-keys.ts";
import { RichMessageComposer, type RichMessageComposerActions } from "./rich-message-composer.tsx";
import { ChecklistComposer } from "./checklist-composer.tsx";
import { ContactCardComposer } from "./contact-card-composer.tsx";
import { ComposerEmojiPickers, type LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { DraftFormatButton, DraftFormatControls, draftFormattingShortcuts, draftLinkShortcuts, useDraftFormatting } from "./draft-formatting.tsx";
import { captionFormatForRanges, trimDraftRanges } from "../core/draft-formatting.ts";
import { encodeRecording, readVoiceFile, useNoteCapture, VoiceNoteControls, VideoNoteControls, type VoiceNoteDraft, type VideoNoteDraft } from "./note-recorder.tsx";
import type { DocumentSendOptions, LocalMediaKind, VideoEdit, VoiceTrim } from "../core/contract.ts";
import { MediaSendControls } from "./media-send-controls.tsx";
import { MediaChoiceButtons } from "./media-choice-buttons.tsx";
import { MessageEffectPicker } from "./message-effect.tsx";
import type { MessageEffectChoice } from "../core/contract.ts";
import { useCanScheduleAttachmentWhenOnline } from "./attachment-delivery.tsx";
import { formatSize } from "./format-size.ts";

type Kind = "sticker" | "gif";
type Format = "ogg" | "webm" | "mp4";
type Choice = z.infer<typeof schemas.mediaChoices.output>[number] & { gifToken?: string; editableGif?: true };
type Choices = Choice[];
type LocalAlbumItem = { kind: "photo"; base64: string } | { kind: "document" | "audio"; file: File } | { kind: "video"; file: File; videoEdit?: VideoEdit }
  | { kind: "livePhoto"; photo: string | File; file: File };
export type ComposerMediaActions = Partial<RichMessageComposerActions> & {
  recordingActivity?: DispatchRecordingActivity;
  choices: (kind: Kind) => Promise<Choices>;
  searchGifs?: (query: string) => Promise<Choices>;
  sendFoundGif?: (token: string, delivery?: MediaDelivery, gif?: GifSendOptions) => Promise<string>;
  clearRecentStickers?: () => Promise<"cleared" | "unavailable" | "unknown">;
  stickerPackDiscovery?: StickerPackDiscoveryActions;
  stickerPackLibrary?: StickerPackLibraryActions;
  stickerPacks?: () => Promise<StickerPackSummary[]>;
  reorderStickerPacks?: (order: string[], expected: string[]) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
  stickerPackPage?: (packId: string, offset: number) => Promise<{ choices: Choices; next: number | null }>;
  groupStickerPage?: (packId: string | undefined, offset: number) => Promise<{ id: string; title: string; choices: Choices; next: number | null } | null>;
  sendGroupSticker?: (packId: string, fileId: number, delivery?: MediaDelivery) => Promise<string>;
  searchStickers?: (query: string) => Promise<Choices>;
  sendChoice: (kind: Kind, fileId: number, searchQuery?: string, packId?: string, delivery?: MediaDelivery, gif?: GifSendOptions) => Promise<string>;
  paidMediaLimit?: () => Promise<number | null>;
  sendAlbum: (caption: string, photos: string[], delivery?: AttachmentSendDelivery, options?: AlbumSendOptions) => Promise<string>;
  sendMediaFile?: (file: File, caption: string, signal: AbortSignal, progress: (uploaded: number, canCancel: boolean) => void,
    delivery: MediaDelivery | undefined, options: DocumentSendOptions & { mediaKind: LocalMediaKind }) => Promise<string>;
  sendMixedAlbum?: (caption: string, items: LocalAlbumItem[], signal: AbortSignal,
    progress: (uploaded: number, total: number, canCancel: boolean) => void, delivery?: AttachmentSendDelivery, options?: AlbumSendOptions) => Promise<string>;
  sendLivePhoto?: (caption: string, photo: string | File, clip: File, signal: AbortSignal,
    progress: (uploaded: number, total: number, canCancel: boolean) => void, delivery?: MediaDelivery, options?: AttachmentSendOptions) => Promise<string>;
  sendVideoNote?: (base64: string, format: "webm" | "mp4", delivery?: MediaDelivery) => Promise<string>;
  checklistAvailability?: () => Promise<ChecklistAvailability>;
  sendChecklist?: (draft: ChecklistDraft, delivery?: MediaDelivery) => Promise<string>;
  sendContactCard?: (contact: ContactDraft, delivery?: MediaDelivery) => Promise<string>;
  sendLocation?: (point: LocationPoint, delivery?: MediaDelivery) => Promise<string>;
  sendVoice: (base64: string, duration: number, format: Format, delivery?: MediaDelivery, trim?: VoiceTrim) => Promise<string>;
};

function AlbumFileCaption({ id, input: firstInput, label, text, storage, disabled, change, groupEmoji, exchangeDraft }: {
  id: string;
  input?: RefObject<HTMLTextAreaElement | null>;
  label: string;
  text: string;
  storage: DraftRecord<DraftFormatting | undefined>;
  disabled: boolean;
  change: (text: string) => void;
  groupEmoji?: { id: string; load: LoadGroupEmoji };
  exchangeDraft?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const localInput = useRef<HTMLTextAreaElement>(null);
  const input = firstInput ?? localInput;
  const formatting = useDraftFormatting(id, text, input, [], true, [], storage);
  return <div className="mtg-album-file-caption">
    <MediaCaptionEditor {...{ label, input, formatting, disabled, change, groupEmoji, exchangeDraft }} value={text} />
  </div>;
}

function MediaCaptionEditor({ label, value, input, formatting, disabled, change, groupEmoji, exchangeDraft }: {
  label: string;
  value: string;
  input: RefObject<HTMLTextAreaElement | null>;
  formatting: ReturnType<typeof useDraftFormatting>;
  disabled: boolean;
  change: (value: string) => void;
  groupEmoji?: { id: string; load: LoadGroupEmoji };
  exchangeDraft?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return <>
    <label className="mtg-media-caption-input">{label} <textarea ref={input} rows={1} value={value} maxLength={1024} disabled={disabled}
      aria-keyshortcuts={`${draftFormattingShortcuts} ${draftLinkShortcuts}${exchangeDraft ? " Control+S" : ""}`}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onKeyDown={(event) => {
        exchangeDraft?.(event);
        if (!event.defaultPrevented) formatting.shortcut(event);
      }}
      onPaste={(event) => formatting.paste(event, change)}
      onChange={(event) => {
        formatting.change(event.currentTarget.value, event.currentTarget.selectionEnd);
        change(event.currentTarget.value);
      }} /></label>
    <ComposerEmojiPickers group={groupEmoji} disabled={disabled}
      insert={(choice) => formatting.insertCustomEmoji(choice, change)} />
    <DraftFormatButton formatting={formatting} busy={disabled} />
    <DraftFormatControls formatting={formatting} busy={disabled} previewLabel={`Formatted ${label.toLowerCase()} preview`} />
  </>;
}

export type MediaComposerController = {
  addDroppedMedia: (files: File[]) => boolean;
  restoreStashedDraft: (kind: "album" | "rich") => boolean;
};

export function MediaComposer({ actions, voice, audio, videoNote, otherMedia, photos, albumVideo, albumDocuments, albumEffects, scheduleWhenOnline, basicMedia, groupStickers, groupEmoji, paidMessageStars, checklistAllowed = true, onSent, controller, richDraftStorage, draftStash, draftContext }: {
  controller?: Ref<MediaComposerController>;
  richDraftStorage?: { key: string; record: ConversationDrafts["rich"]; replies?: ConversationDrafts["richReplies"] };
  draftStash?: DraftStash;
  draftContext?: {
    destination: ReplyOrigin;
    reply?: ComposerReply;
    checkExternalReply?: (chatId: string, messageId: string) => Promise<boolean>;
    actionsForReply: (reply?: MediaReply) => ComposerMediaActions;
  };
  actions: ComposerMediaActions;
  voice: boolean;
  audio?: boolean;
  videoNote?: boolean;
  otherMedia: boolean;
  photos: boolean;
  albumVideo?: boolean;
  albumDocuments?: boolean;
  albumEffects?: { chatId: string; load: (id: string) => Promise<MessageEffectChoice[]> };
  scheduleWhenOnline?: { chatId: string; check: (id: string) => Promise<boolean> };
  paidMessageStars?: number;
  basicMedia?: boolean;
  groupStickers?: boolean;
  groupEmoji?: { id: string; load: LoadGroupEmoji };
  checklistAllowed?: boolean;
  onSent?: () => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [richDrafts, setRichDrafts] = useDraftRecord(richDraftStorage?.record);
  const richDraftKey = richDraftStorage?.key ?? "";
  const richBlocks = richDrafts[richDraftKey];
  const [richReplies, setRichReplies] = useDraftRecord(richDraftStorage?.replies);
  const [albumReply, setAlbumReply] = useState<SpecializedDraftReply>();
  const richReply = richReplies[richDraftKey];
  const [panel, setPanel] = useState<Kind | "voice" | "video" | "livePhoto" | "album" | "documentAlbum" | "audioAlbum" | "audioFile" | "gifFile" | "location" | "contact" | "checklist" | "rich">();
  const [restoreRichRequest, setRestoreRichRequest] = useState<number>();
  const [focusRestoredRich, setFocusRestoredRich] = useState(false);
  const [choices, setChoices] = useState<Choices>();
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string>();
  const [packs, setPacks] = useState<StickerPackSummary[]>();
  const [confirmClearRecent, setConfirmClearRecent] = useState(false);
  const [editingPackOrder, setEditingPackOrder] = useState(false);
  const [packId, setPackId] = useState<string>();
  const [groupPackTitle, setGroupPackTitle] = useState<string>();
  const [moreStickers, setMoreStickers] = useState<number | null>(null);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [loadingPackPage, setLoadingPackPage] = useState(false);
  const [selected, setSelected] = useState<Choices[number]>();
  const nextAlbumPhotoId = useRef(0);
  const [separateCaptions, setSeparateCaptions] = useState(false);
  const [itemFormatting] = useState(createDraftRecord<DraftFormatting | undefined>);
  const [album, setAlbum] = useState<(import("./local-drafts.ts").AlbumDraft["files"][number] & { id: number })[]>([]);
  const canAlbumVideo = !!albumVideo && !!actions.sendMixedAlbum;
  const canAlbumDocuments = !!albumDocuments && !!actions.sendMixedAlbum && paidMessageStars === undefined;
  const canAlbumAudio = !!audio && !!actions.sendMixedAlbum && paidMessageStars === undefined;
  const albumPermissions = { photo: photos, video: canAlbumVideo, document: canAlbumDocuments, audio: canAlbumAudio };
  const canSendAlbumFiles = album.every(({ kind }) => albumPermissions[kind]);
  const documents = panel === "documentAlbum";
  const audioAlbum = panel === "audioAlbum";
  const fileAlbum = documents || audioAlbum;
  const albumUpload = useRef<AbortController>(undefined);
  const [albumProgress, setAlbumProgress] = useState<{ uploaded: number; total: number; canCancel: boolean }>();
  const [albumOptions, setAlbumOptions] = useState<MediaSendOptions>();
  const [albumEffect, setAlbumEffect] = useState<MessageEffectChoice>();
  const sendLivePhoto = photos && paidMessageStars === undefined ? actions.sendLivePhoto : undefined;
  const [liveStill, setLiveStill] = useState<File>();
  const [liveClip, setLiveClip] = useState<File>();
  const [importingLivePhoto, setImportingLivePhoto] = useState(false);
  const liveFileRevision = useRef(0);
  const [liveCaption, setLiveCaption] = useState("");
  const [liveOptions, setLiveOptions] = useState<MediaSendOptions>();
  const liveCaptionInput = useRef<HTMLTextAreaElement>(null);
  const liveFormatting = useDraftFormatting("livePhoto", liveCaption, liveCaptionInput, [], true);
  const [paidLimit, setPaidLimit] = useState<number | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const canAlbumMotion = photos && !!actions.sendMixedAlbum && paidMessageStars === undefined && !priceDraft;
  const hasAlbumMotion = album.some(({ motion }) => !!motion);
  const hasUneditedAlbumVideo = album.some(({ kind, videoEdit }) => kind === "video" && !videoEdit);
  const hasEditedAlbumVideo = album.some(({ kind, videoEdit }) => kind === "video" && !!videoEdit);
  const paidStars = !fileAlbum && priceDraft.trim() ? Number(priceDraft) : undefined;
  const paidAlbum = paidMessageStars !== undefined || paidStars !== undefined;
  const canUseSeparateCaptions = paidMessageStars === undefined && paidStars === undefined;
  const invalidPaidPrice = paidStars !== undefined && (!paidLimit || !Number.isSafeInteger(paidStars)
    || paidStars < 1 || paidStars > paidLimit || albumOptions?.spoiler);
  const albumCost = paidMessageStars === undefined ? undefined : paidMessageStars * album.length;
  const [mediaFile, setMediaFile] = useState<File>();
  const [fileProgress, setFileProgress] = useState<{ uploaded: number; canCancel: boolean }>();
  const canSendMediaFile = paidMessageStars === undefined && actions.sendMediaFile;
  const fileKind = panel === "audioFile" ? "audio" : panel === "gifFile" ? "animation" : undefined;
  const fileLabel = fileKind === "audio" ? tr("audio file") : tr("GIF file");
  const [gifCaption, setGifCaption] = useState("");
  const [gifOptions, setGifOptions] = useState<MediaSendOptions>();
  const [gifTrim, setGifTrim] = useState<AnimationTrim>();
  const gifHasEdits = panel === "gif" && (!!gifCaption.trim() || !!gifOptions?.spoiler);
  const canEditSelectedGif = !selected?.gifToken || selected.editableGif === true;
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const point = locationPoint.safeParse({
    latitude: latitude === "" ? NaN : Number(latitude), longitude: longitude === "" ? NaN : Number(longitude),
  }).data;
  const sendLocation = basicMedia ? actions.sendLocation : undefined;
  const sendContactCard = basicMedia ? actions.sendContactCard : undefined;
  const sendRichMessage = basicMedia ? actions.sendRichMessage : undefined;
  const sendChecklist = basicMedia && checklistAllowed ? actions.sendChecklist : undefined;
  const [caption, setCaption] = useState("");
  const hasAlbumCaption = separateCaptions ? album.some((item) => item.caption?.trim()) : !!caption.trim();
  const albumCaptionInput = useRef<HTMLTextAreaElement>(null);
  const albumPicker = useRef<HTMLInputElement>(null);
  const gifCaptionInput = useRef<HTMLTextAreaElement>(null);
  const albumFormatting = useDraftFormatting("album", caption, albumCaptionInput, [], true);
  const gifFormatting = useDraftFormatting("gif", gifCaption, gifCaptionInput, [], true);
  const [note, setNote] = useState<VoiceNoteDraft>();
  const [video, setVideo] = useState<VideoNoteDraft>();
  const capture = useNoteCapture();
  const [working, setBusy] = useState(false);
  const busy = working || capture.preparing;
  const [silent, setSilent] = useState(false);
  const [deliveryTime, setDeliveryTime] = useState("");
  const [whenOnline, setWhenOnline] = useState(false);
  const onlineAllowed = useCanScheduleAttachmentWhenOnline(
    (fileKind || panel === "album" || fileAlbum) && !paidAlbum ? scheduleWhenOnline?.chatId : undefined,
    scheduleWhenOnline?.check);
  const scheduledMedia = !!deliveryTime || whenOnline;
  const canApplyAlbumEffect = !!albumEffects && !paidAlbum
    && !(albumReply ? albumReply.reply : draftContext?.reply)?.origin;
  const [status, setStatus] = useState("");
  const active = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      albumUpload.current?.abort();
      request.current++;
    };
  }, []);

  function moveAlbumPhoto(index: number, offset: -1 | 1) {
    setAlbum((previous) => {
      const target = index + offset;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [photo] = next.splice(index, 1);
      if (!photo) return previous;
      next.splice(target, 0, photo);
      return next;
    });
  }

  async function loadMotionPhoto(file: File) {
    const revision = ++liveFileRevision.current;
    const panelRequest = request.current;
    setImportingLivePhoto(true);
    setStatus("");
    try {
      const pair = await importMotionPhoto(file).catch(() => undefined);
      if (!active.current || revision !== liveFileRevision.current || panelRequest !== request.current) return;
      if (!pair) {
        setStatus("Could not find a valid motion clip in this image. Choose another Motion Photo or select the two files separately.");
        return;
      }
      setLiveStill(pair.still);
      setLiveClip(pair.clip);
    } finally {
      if (active.current && revision === liveFileRevision.current) setImportingLivePhoto(false);
    }
  }

  async function open(kind: NonNullable<typeof panel>) {
    if ((kind === "album" || kind === "documentAlbum" || kind === "audioAlbum") && album.length
      && kind !== albumPanelForKind(album[0]?.kind)) {
      setStatus("Remove the selected files before changing the album type.");
      return;
    }
    const generation = ++request.current;
    setRestoreRichRequest(undefined);
    setFocusRestoredRich(false);
    setPanel(kind);
    setWhenOnline(false);
    setConfirmClearRecent(false);
    setGifTrim(undefined);
    setMediaFile(undefined);
    setGifCaption("");
    gifFormatting.reset();
    setGifOptions(undefined);
    setSearchQuery("");
    setSubmittedQuery(undefined);
    setPackId(undefined);
    setGroupPackTitle(undefined);
    setPacks(undefined);
    setEditingPackOrder(false);
    setMoreStickers(null);
    setLoadingPacks(false);
    setLoadingPackPage(false);
    setStatus("");
    setSelected(undefined);
    setChoices(undefined);
    if (kind === "album" && actions.paidMediaLimit) {
      setPaidLimit(null);
      const limit = await actions.paidMediaLimit().catch(() => null);
      if (request.current === generation) setPaidLimit(limit);
      return;
    }
    if (kind !== "sticker" && kind !== "gif") return;
    try {
      const result = await actions.choices(kind);
      if (request.current === generation) setChoices(result);
    } catch {
      if (request.current === generation) {
        setChoices([]);
        setStatus("Could not load media from Telegram.");
      }
    }
  }

  const search = panel === "sticker" ? actions.searchStickers : panel === "gif" ? actions.searchGifs : undefined;

  async function findMedia() {
    const query = searchQuery.trim();
    if (!query || !search) return;
    const generation = ++request.current;
    setSelected(undefined);
    setChoices(undefined);
    setSubmittedQuery(query);
    setPackId(undefined);
    setGroupPackTitle(undefined);
    setMoreStickers(null);
    setLoadingPacks(false);
    setLoadingPackPage(false);
    setStatus("");
    try {
      const result = await search(query);
      if (request.current === generation) setChoices(result);
    } catch {
      if (request.current === generation) {
        setChoices([]);
        setStatus(panel === "sticker" ? "Could not search for stickers." : "Could not search for GIFs.");
      }
    }
  }

  async function clearRecentStickers() {
    if (!actions.clearRecentStickers || busy) return;
    const generation = request.current;
    setConfirmClearRecent(false);
    setBusy(true);
    setStatus("");
    try {
      const result = await actions.clearRecentStickers().catch(() => "unknown" as const);
      if (!active.current || generation !== request.current) return;
      const message = result === "cleared" ? "Recent stickers cleared." : "Could not confirm clearing recent stickers.";
      if (result === "unavailable") {
        setStatus(message);
        return;
      }
      setSelected(undefined);
      setChoices(undefined);
      const choices = await actions.choices("sticker").catch(() => undefined);
      if (!active.current || generation !== request.current) return;
      setChoices(choices ?? []);
      setStatus(choices ? message : tr("{0} Could not refresh the sticker list.", [message]));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function browsePacks() {
    if (!actions.stickerPacks || loadingPacks) return;
    const generation = request.current;
    setLoadingPacks(true);
    setStatus("");
    try {
      const result = await actions.stickerPacks();
      if (request.current === generation) setPacks(result);
    } catch {
      if (request.current === generation) setStatus("Could not load installed sticker packs.");
    } finally {
      if (request.current === generation) setLoadingPacks(false);
    }
  }

  async function openPack(id: string | undefined, offset = 0, group = false) {
    if (loadingPackPage) return;
    const groupPage = group ? actions.groupStickerPage : undefined;
    if (group ? !groupPage : !id || !actions.stickerPackPage) return;
    const generation = ++request.current;
    setLoadingPackPage(true);
    setLoadingPacks(false);
    setSubmittedQuery(undefined);
    setPackId(id);
    if (!group || !offset) setGroupPackTitle(undefined);
    setStatus("");
    if (!offset) {
      setSelected(undefined);
      setChoices(undefined);
      setMoreStickers(null);
    }
    try {
      const groupResult = groupPage ? await groupPage(id, offset) : undefined;
      const page = groupPage ? groupResult : await actions.stickerPackPage!(id!, offset);
      if (request.current !== generation) return;
      if (!page || (groupResult && id !== undefined && groupResult.id !== id)) {
        setChoices([]);
        setSelected(undefined);
        setMoreStickers(null);
        setStatus(offset ? "The group sticker pack changed. Open it again." : "No group sticker pack is available.");
        return;
      }
      if (groupResult) {
        setPackId(groupResult.id);
        setGroupPackTitle(groupResult.title);
      }
      setChoices((previous) => {
        if (!offset || !previous) return page.choices;
        const seen = new Set(previous.map(({ id }) => id));
        return [...previous, ...page.choices.filter(({ id }) => !seen.has(id))];
      });
      setMoreStickers(page.next);
    } catch {
      if (request.current === generation) {
        if (!offset) setChoices([]);
        setStatus("Could not load stickers in this pack.");
      }
    } finally {
      if (request.current === generation) setLoadingPackPage(false);
    }
  }

  async function submit(send: (delivery?: AttachmentSendDelivery) => Promise<string>, replyOverride?: SpecializedDraftReply) {
    const at = deliveryTime ? Math.floor(new Date(deliveryTime).getTime() / 1000) : undefined;
    if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) {
      setStatus("Choose a send time in the future.");
      return;
    }
    if (whenOnline && (!onlineAllowed || at !== undefined)) {
      setStatus("Sending when online is unavailable here. Clear the option to continue.");
      return;
    }
    const delivery: AttachmentSendDelivery | undefined = silent || scheduledMedia ? {
      ...(silent && { silent: true }), ...(at === undefined ? {} : { at }), ...(whenOnline && { whenOnline: true }),
    } : undefined;
    setBusy(true);
    setStatus("");
    try {
      const state = await send(delivery);
      if (!active.current) return;
      if (state === "sent") {
        if (panel === "livePhoto" || fileKind) {
          if (fileKind) {
            setGifTrim(undefined);
            setMediaFile(undefined);
            setGifCaption("");
            setGifOptions(undefined);
            gifFormatting.reset();
          } else {
            setLiveStill(undefined);
            setLiveClip(undefined);
            setLiveCaption("");
            setLiveOptions(undefined);
            liveFormatting.reset();
          }
          onSent?.();
          setPanel(undefined);
          setSilent(false);
          setDeliveryTime("");
          setWhenOnline(false);
          setStatus(scheduledMedia ? "Scheduled." : "Sent.");
          return;
        }
        if (!replyOverride) onSent?.();
        setAlbumReply(undefined);
        setSelected(undefined);
        setAlbum([]);
        setSeparateCaptions(false);
        itemFormatting.update({});
        setAlbumOptions(undefined);
        setAlbumEffect(undefined);
        setPriceDraft("");
        setCaption("");
        albumFormatting.reset();
        setLatitude("");
        setLongitude("");
        setGifCaption("");
        gifFormatting.reset();
        setGifOptions(undefined);
        setNote(undefined);
        setVideo(undefined);
        setPanel(undefined);
        setSilent(false);
        setDeliveryTime("");
        setWhenOnline(false);
        setStatus(scheduledMedia ? "Scheduled." : "Sent.");
      } else setStatus(state === "premium_required" ? panel === "checklist"
        ? "Telegram Premium is required to send checklists." : "Telegram Premium is required for a file of this size."
        : state === "video_preparation_failed" ? panel === "rich"
          ? "BB could not prepare a video in the formatted message. Your draft is still here."
          : hasEditedAlbumVideo
          ? "BB could not prepare a video in this album. Your video edits are still here."
          : albumOptions?.originalVideo
          ? "Original video quality is unavailable for a file in this album. Your draft is still here."
          : "BB could not prepare a video in this album. Your draft is still here."
        : state === "media_preparation_failed" ? audioAlbum
          ? "BB could not read a track in this album. Your selection and captions are still here."
          : "BB could not read this media file. Your selection and caption are still here."
        : state === "file_too_large" ? "This file exceeds Telegram’s upload limit."
        : state === "legacy_tdlib" ? "Update TDLib to upload a file of this size."
        : state === "reply_unavailable" ? "The reply target is unavailable. Your selection and caption are still here."
        : state === "cancelled" ? "Upload cancelled. Your selection is still here."
        : state === "unavailable" ? "This action is unavailable in the conversation."
        : state === "failed" ? (panel === "rich" ? "Could not send the formatted message. Your draft is still here." : "Could not send this media. Your selection is still here.")
        : "Delivery unconfirmed. Check the chat before retrying.");
    } catch {
      if (active.current) setStatus("Could not send this media.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function record(kind: "voice" | "video") {
    setStatus("");
    if (kind === "video") setVideo(undefined);
    else setNote(undefined);
    void capture.record(kind, (result) => {
      if (result.kind === "video") setVideo(result.note);
      else setNote(result.note);
    }, setStatus, actions.recordingActivity);
  }

  async function chooseVoice(file: File) {
    setBusy(true);
    setStatus("");
    try {
      const recording = await readVoiceFile(file);
      if (active.current) setNote(recording);
    } catch {
      if (active.current) setStatus("Choose a playable voice file up to two minutes and 4 MiB.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function albumPanelForKind(kind?: "photo" | "video" | "document" | "audio") {
    return kind === "document" ? "documentAlbum" : kind === "audio" ? "audioAlbum" : "album";
  }

  function albumFileKind(file: File, mode: "album" | "audioAlbum" | "documentAlbum" = "album"): "photo" | "video" | "document" | "audio" | undefined {
    if (mode !== "album") {
      if (!file.name || file.name.length > 255 || !file.size || file.size > maxTelegramUploadBytes) return;
      if (mode === "audioAlbum") return canAlbumAudio && isAudioAttachmentName(file.name) ? "audio" : undefined;
      return canAlbumDocuments ? "document" : undefined;
    }
    if (photos && isPhotoMimeType(file.type) && file.size > 0 && file.size <= maxOriginalPhotoBytes) return "photo";
    if (canAlbumVideo && isVideoAttachmentName(file.name) && file.size > 0 && file.size <= maxTelegramUploadBytes) return "video";
  }

  function addAlbumFiles(files: File[], mode = documents ? "documentAlbum" as const : audioAlbum ? "audioAlbum" as const : "album" as const) {
    if (!files.length) return;
    if (album.length + files.length > 10) {
      setStatus(mode !== "album" || canAlbumVideo ? "An album can contain up to 10 items." : "An album can contain up to 10 photos.");
      return;
    }
    const additions = files.flatMap((file) => {
      const kind = albumFileKind(file, mode);
      return kind ? [{ id: nextAlbumPhotoId.current++, file, kind }] : [];
    });
    if (additions.length !== files.length) {
      setStatus(mode === "audioAlbum" ? "Choose MP3 or M4A tracks within Telegram’s file size limit."
        : mode === "documentAlbum" ? "Choose non-empty files within Telegram’s file size limit."
        : canAlbumVideo ? "Choose supported MP4 or MOV videos or photos allowed in this chat."
        : "Choose non-empty JPEG, PNG or WebP photos up to 64 MiB each.");
      return;
    }
    setAlbum((previous) => [...previous, ...additions]);
    setStatus("");
  }

  async function addAlbumMotionPhotos(files: File[]) {
    if (!files.length || !canAlbumMotion || busy) return;
    if (album.length + files.length > 10) {
      setStatus("An album can contain up to 10 items.");
      return;
    }
    setBusy(true);
    setStatus("Importing Motion Photos…");
    try {
      const items: typeof album = [];
      for (const file of files) {
        const pair = await importMotionPhoto(file);
        if (!active.current) return;
        if (!pair) {
          setStatus("Each selected file must contain a valid Motion Photo.");
          return;
        }
        items.push({ id: nextAlbumPhotoId.current++, kind: "photo", file: pair.still, motion: pair.clip });
      }
      setAlbum((previous) => [...previous, ...items]);
      setStatus("");
    } catch {
      if (active.current) setStatus("Could not import the selected Motion Photos.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const switchDisabled = busy || capture.recording;
  const canExchangeAlbum = !!draftStash && !!draftContext && !switchDisabled && paidMessageStars === undefined && (fileAlbum || !priceDraft);
  const activeReplyOverride = panel === "rich" ? richReply : panel === "album" || fileAlbum ? albumReply : undefined;
  const beginAlbumCheck = useDraftStashCheck(JSON.stringify([panel, documents, audioAlbum, caption, separateCaptions, albumFormatting.ranges,
    albumFormatting.links, albumFormatting.customEmoji, albumOptions, silent, deliveryTime, canExchangeAlbum, albumPermissions, canAlbumMotion,
    albumEffect?.id, whenOnline, !!sendRichMessage, !!actions.richMessageLimits]),
    album, albumReply ? albumReply.reply : draftContext?.reply);
  const beginRichCheck = useDraftStashCheck(JSON.stringify([panel, switchDisabled, silent, deliveryTime, photos, albumVideo,
    albumDocuments, paidMessageStars]), richReply, draftContext?.reply);

  function supportsAlbumDraft(restored: AlbumDraft) {
    const permissions = albumPermissions;
    if (restored.audio ? !permissions.audio : restored.documents ? !permissions.document : !permissions.photo && !permissions.video) {
      return false;
    }
    return restored.files.every(({ kind, motion }) => permissions[kind] && (!motion || canAlbumMotion));
  }

  function supportsFormattedDraft(blocks: RichComposerBlock[], limits: { media: number; columns: number }) {
    return blocks.every(({ kind }) => {
      if (kind === "photo") return limits.media > 0 && photos;
      if (kind === "video") return limits.media > 0 && !!albumVideo;
      if (kind === "document") return limits.media > 0 && !!albumDocuments;
      return kind !== "table" || limits.columns > 0;
    });
  }

  function applyAlbumDraft(restored?: AlbumDraft, focus = true) {
    const restoredCaption = restored?.caption ?? { text: "" };
    setSeparateCaptions(restored?.separateCaptions ?? false);
    if (restored) setPanel(restored.audio ? "audioAlbum" : restored.documents ? "documentAlbum" : "album");
    const restoredFormats: Record<string, DraftFormatting | undefined> = {};
    setAlbum(restored?.files.map(({ captionFormatting, ...file }) => {
      const id = nextAlbumPhotoId.current++;
      if (captionFormatting) restoredFormats[id] = captionFormatting;
      return { ...file, id };
    }) ?? []);
    itemFormatting.update(restoredFormats);
    setAlbumReply({ reply: restored?.reply });
    setCaption(restoredCaption.text);
    albumFormatting.restore(restoredCaption);
    setAlbumOptions(restored?.options);
    setAlbumEffect(undefined);
    setSilent(restored?.silent ?? false);
    setDeliveryTime(restored?.deliveryTime ?? "");
    setWhenOnline(restored?.whenOnline === true);
    if (restored?.reply?.origin) setPriceDraft("");
    if (focus) requestAnimationFrame(() => (restored?.files.length ? albumCaptionInput.current : albumPicker.current)?.focus());
  }

  function applyFormattedDelivery(restored?: Extract<SpecializedDraft, { kind: "rich" }>["value"]) {
    setRichReplies((previous) => ({ ...previous, [richDraftKey]: { reply: restored?.reply } }));
    setSilent(restored?.silent ?? false);
    setDeliveryTime(restored?.deliveryTime ?? "");
    setWhenOnline(false);
  }

  async function exchangeAlbumDraft() {
    if (!canExchangeAlbum || !draftStash || !draftContext) return;
    const stillCurrent = beginAlbumCheck();
    const candidate = draftStash.review();
    const formats = itemFormatting.getSnapshot();
    const unchanged = () => active.current && stillCurrent() && candidate.stillCurrent()
      && itemFormatting.getSnapshot() === formats
      && (!richDraftStorage || richDraftStorage.record.getSnapshot()[richDraftKey] === richBlocks);
    const outgoing: SpecializedDraft = {
      kind: "album",
      value: {
        documents, audio: audioAlbum, files: album.map(({ id, ...file }) => ({ ...file, captionFormatting: formats[id] })),
        options: albumOptions, silent, deliveryTime, separateCaptions, ...(whenOnline && { whenOnline: true }),
        reply: albumReply ? albumReply.reply : draftContext.reply,
        caption: { text: caption, styles: albumFormatting.ranges, links: albumFormatting.links, customEmoji: albumFormatting.customEmoji },
      },
    };
    if (candidate.kind === "rich" && richBlocks && hasFormattedDraft(richBlocks)) {
      setStatus("A formatted draft is already open in this conversation.");
      return;
    }
    let richLimits: { media: number; columns: number } | undefined;
    if (candidate.kind === "rich" && sendRichMessage && actions.richMessageLimits) {
      setStatus("Checking formatted message availability…");
      const limits = await actions.richMessageLimits().catch(() => null);
      if (!unchanged()) return;
      richLimits = limits && limits !== "premium_required" ? limits : undefined;
    }
    const validate = (draft: SpecializedDraft) => (draft.kind === "album" ? supportsAlbumDraft(draft.value)
      : !!richLimits && supportsFormattedDraft(draft.value.blocks, richLimits)) ? undefined : "unsupported" as const;
    const exchange = (proof?: () => boolean) => draftStash.exchangeSpecialized(outgoing, draftContext.destination, validate, proof);
    let result = exchange();
    if (result.state === "differentConversation" && draftContext.checkExternalReply) {
      setStatus("Checking whether the stashed reply can move here…");
      const proof = await draftStash.checkExternalReply(draftContext.checkExternalReply).catch(() => undefined);
      if (!unchanged()) return;
      if (proof) result = exchange(proof);
    }
    if (result.state === "differentConversation") {
      setStatus(candidate.kind === "rich" ? "This formatted reply can only be restored in its original conversation."
        : "This album reply can only be restored in its original conversation.");
    } else if (result.state === "composer") {
      setStatus("Restore the stashed draft in the message composer first.");
    } else if (result.state === "unsupported") {
      setStatus(candidate.kind === "rich" ? "This conversation cannot send the stashed formatted draft." : "This conversation cannot send the stashed album.");
    } else if (result.state === "empty") {
      setStatus("No album draft to exchange.");
    } else if (result.state === "exchanged") {
      const restored = result.restored;
      if (restored?.kind === "rich") {
        applyAlbumDraft(undefined, false);
        setRichDrafts((previous) => ({ ...previous, [richDraftKey]: restored.value.blocks }));
        applyFormattedDelivery(restored.value);
        setRestoreRichRequest(undefined);
        setFocusRestoredRich(true);
        setPanel("rich");
        setStatus("Formatted draft restored.");
      } else {
        applyAlbumDraft(restored?.value);
        setStatus(restored ? "Album draft restored." : "Album draft set aside.");
      }
    }
  }
  function handleAlbumDraftKey(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!isStashShortcut(event)) return;
    event.preventDefault();
    if (!event.repeat) void exchangeAlbumDraft();
  }

  function exchangeFormattedDraft(blocks: RichComposerBlock[], limits: { media: number; columns: number },
    restoreOnly: boolean, blocksStillCurrent: () => boolean) {
    if (!draftStash || !draftContext || switchDisabled || paidMessageStars !== undefined) return;
    const { destination, checkExternalReply } = draftContext;
    const candidate = draftStash.review();
    if (restoreOnly) {
      setRestoreRichRequest(undefined);
      if (hasFormattedDraft(blocks)) {
        setStatus("A formatted draft is already open. Exchange it to restore the stashed draft.");
        return;
      }
      if (candidate.kind !== "rich") return;
    }
    const stillCurrent = beginRichCheck();
    const stillAlbumCurrent = beginAlbumCheck();
    const outgoing: SpecializedDraft = { kind: "rich", value: { blocks, silent, deliveryTime, reply: richReply ? richReply.reply : draftContext.reply } };
    const validate = (draft: SpecializedDraft) => {
      if (draft.kind === "rich") return supportsFormattedDraft(draft.value.blocks, limits) ? undefined : "unsupported";
      if (album.length || caption || priceDraft) return "occupied";
      return supportsAlbumDraft(draft.value) ? undefined : "unsupported";
    };
    const exchange = (proof?: () => boolean) => draftStash.exchangeSpecialized(outgoing, destination, validate, proof);
    const apply = (result: ReturnType<typeof exchange>) => {
      if (result.state === "exchanged") {
        const restored = result.restored;
        if (restored?.kind === "album") {
          setRichDrafts((previous) => {
            const next = { ...previous };
            delete next[richDraftKey];
            return next;
          });
          setRichReplies((previous) => {
            const next = { ...previous };
            delete next[richDraftKey];
            return next;
          });
          applyAlbumDraft(restored.value);
          setStatus("Album draft restored.");
          return;
        }
        applyFormattedDelivery(restored?.value);
        setStatus(restored ? "Formatted draft restored." : "Formatted draft set aside.");
        return restored?.value.blocks ?? [{ id: 0, kind: "paragraph", text: "" } satisfies RichComposerBlock];
      }
      setStatus(result.state === "unsupported" ? candidate.kind === "album"
        ? "This conversation cannot send the stashed album." : "This conversation cannot send the stashed formatted draft."
        : result.state === "occupied" ? "An album draft is already open in this conversation."
        : result.state === "empty" ? "No formatted draft to exchange."
        : result.state === "differentConversation" ? candidate.kind === "album"
          ? "This album reply can only be restored in its original conversation." : "This formatted reply can only be restored in its original conversation."
        : "Restore the stashed draft in the message composer first.");
    };
    const result = exchange();
    if (result.state !== "differentConversation" || !checkExternalReply) return apply(result);
    setStatus("Checking whether the stashed reply can move here…");
    return draftStash.checkExternalReply(checkExternalReply).catch(() => undefined).then((proof) => {
      if (!active.current || !stillCurrent() || !stillAlbumCurrent() || !blocksStillCurrent() || !candidate.stillCurrent()) return;
      return apply(proof ? exchange(proof) : result);
    });
  }

  useImperativeHandle(controller, () => ({
    restoreStashedDraft(kind) {
      if (!draftStash || switchDisabled || paidMessageStars !== undefined) return false;
      if (kind === "rich") {
        if (!sendRichMessage || !actions.richMessageLimits || (panel && panel !== "rich")) return false;
        void open("rich");
        setRestoreRichRequest(request.current);
        return true;
      }
      if (!canExchangeAlbum || (panel && panel !== "album" && !fileAlbum)) return false;
      if (album.length || caption) {
        setPanel(album.length ? albumPanelForKind(album[0]?.kind) : documents ? "documentAlbum" : audioAlbum ? "audioAlbum" : "album");
        setStatus("An album draft is already open. Exchange it to restore the stashed album.");
      } else {
        void exchangeAlbumDraft();
      }
      return true;
    },
    addDroppedMedia(files) {
      if (switchDisabled) return false;
      const target = documents ? "documentAlbum" : audioAlbum || files.every((file) => !!albumFileKind(file, "audioAlbum"))
        ? "audioAlbum" : files.every((file) => !!albumFileKind(file)) ? "album" : "documentAlbum";
      if (!files.every((file) => !!albumFileKind(file, target))) return false;
      if (album.length && albumPanelForKind(album[0]?.kind) !== target) {
        setStatus("Remove the selected files before changing the album type.");
        return true;
      }
      if (panel !== target) void open(target);
      addAlbumFiles(files, target);
      return true;
    },
  }));
  function entry(enabled: unknown, target: NonNullable<typeof panel>, label: string, Icon: LucideIcon, primary = false) {
    if (!enabled) return;
    return <ComposerActionEntry primary={primary}><button type="button" className="mtg-action"
      disabled={switchDisabled} onClick={() => void open(target)}><Icon size={16} aria-hidden="true" /> {label}</button></ComposerActionEntry>;
  }

  return <div className="mtg-composer-media">
    <div className="mtg-composer-media-buttons">
      {entry(videoNote && actions.sendVideoNote, "video", "Video note", Camera, true)}
      {entry(voice, "voice", "Voice", Mic, true)}
      {entry(otherMedia, "sticker", "Stickers", Sticker)}
      {entry(otherMedia, "gif", "GIFs", FileImage)}
      {entry(canSendMediaFile && audio, "audioFile", "Audio file", FileAudio)}
      {entry(canSendMediaFile && otherMedia, "gifFile", "GIF file", FileImage)}
      {entry(photos || canAlbumVideo, "album", canAlbumVideo ? "Media album" : "Photo album", Images)}
      {entry(sendLivePhoto, "livePhoto", "Live photo", Camera)}
      {entry(canAlbumAudio, "audioAlbum", "Audio album", Music)}
      {entry(canAlbumDocuments, "documentAlbum", "Document album", Files)}
      {entry(sendRichMessage && actions.richMessageLimits, "rich", "Formatted message", FileText)}
      {entry(sendChecklist && actions.checklistAvailability, "checklist", "Checklist", ListChecks)}
      {entry(sendContactCard, "contact", "Contact card", ContactRound)}
      {entry(sendLocation, "location", "Location", MapPin)}
      {panel && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => {
        request.current++; setPanel(undefined); setWhenOnline(false); setStatus("");
      }}>{tr("Close media")}</button>}
    </div>
    {panel && <details>
      <summary>{tr("Media delivery options")}</summary>
      <label><input type="checkbox" checked={silent} disabled={switchDisabled}
        onChange={(event) => setSilent(event.currentTarget.checked)} />{tr(" Send without sound")}</label>
      <label>{tr("Schedule media ")}<input type="datetime-local" value={deliveryTime} disabled={switchDisabled || whenOnline}
        onInput={(event) => { setDeliveryTime(event.currentTarget.value); setStatus(""); }} /></label>
      {(onlineAllowed || whenOnline) && <label><input type="checkbox" checked={whenOnline} disabled={switchDisabled}
        onChange={(event) => {
          const enabled = event.currentTarget.checked && onlineAllowed;
          setWhenOnline(enabled);
          if (enabled) setDeliveryTime("");
          setStatus("");
        }} />{tr(" Send media when online")}</label>}
      {whenOnline && !onlineAllowed && <p role="status">{tr("Sending when online is unavailable here. Clear the option to continue.")}</p>}
    </details>}
    {activeReplyOverride?.reply && <p className="mtg-send-status">{tr("Replying to ")}<bdi>{activeReplyOverride.reply.author}</bdi>{activeReplyOverride.reply.origin ? tr(" in another conversation") : ""}
      {activeReplyOverride.reply.selectedQuote && <q>{activeReplyOverride.reply.selectedQuote.text}</q>}
    </p>}
    {activeReplyOverride && !activeReplyOverride.reply && draftContext?.reply && <p className="mtg-send-status">{tr("This draft has no reply.")}</p>}
    {panel === "livePhoto" && sendLivePhoto && <fieldset>
      <legend>{tr("Live photo")}</legend>
      <label>{tr("Import Motion Photo ")}<input type="file" accept="image/jpeg,image/avif,image/heic,.jpg,.jpeg,.avif,.heic" disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void loadMotionPhoto(file);
      }} /></label>
      {importingLivePhoto && <p role="status">{tr("Reading Motion Photo…")}</p>}
      <label>{tr("Still image ")}<input type="file" accept={`${photoAccept},image/heic,.heic`} disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        liveFileRevision.current++;
        setImportingLivePhoto(false);
        const heic = file.type === "image/heic" || /\.heic$/i.test(file.name);
        const allowed = (heic || isPhotoMimeType(file.type)) && file.size > 0 && file.size <= maxOriginalPhotoBytes;
        setLiveStill(allowed ? heic && file.type !== "image/heic" ? new File([file], file.name, { type: "image/heic" }) : file : undefined);
        setStatus(allowed ? "" : "Choose a JPEG, PNG, WebP or HEIC image up to 64 MiB.");
      }} /></label>
      {liveStill && (liveStill.type === "image/heic" ? <p><bdi>{liveStill.name}</bdi></p>
        : <AttachmentPhotoPreview file={liveStill} alt={tr("Live photo still preview")} />)}
      <label>{tr("Motion clip ")}<input type="file" accept={videoAttachmentAccept} disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        liveFileRevision.current++;
        setImportingLivePhoto(false);
        const allowed = isVideoAttachmentName(file.name) && file.size > 0 && file.size <= maxTelegramUploadBytes;
        setLiveClip(allowed ? file : undefined);
        setStatus(allowed ? "" : "Choose a non-empty MP4 or MOV within Telegram’s file size limit.");
      }} /></label>
      {liveClip && <p><bdi>{liveClip.name}</bdi></p>}
      <MediaCaptionEditor label={tr("Live photo caption")} value={liveCaption} input={liveCaptionInput} formatting={liveFormatting}
        disabled={busy} change={setLiveCaption} groupEmoji={groupEmoji} />
      <MediaSendControls kind="photo" options={liveOptions} hasCaption={!!liveCaption.trim()} disabled={busy} change={setLiveOptions} />
      {albumProgress && <div>
        <progress aria-label={tr("Live photo upload")} value={albumProgress.uploaded} max={albumProgress.total} />
        {albumProgress.canCancel && <button type="button" className="mtg-action" onClick={() => albumUpload.current?.abort()}>{tr("Cancel upload")}</button>}
      </div>}
      <button type="button" className="mtg-action" disabled={busy || importingLivePhoto || !liveStill || !liveClip} onClick={() => {
        if (!liveStill || !liveClip) return;
        void submit(async (delivery) => {
          const controller = new AbortController();
          albumUpload.current = controller;
          const heic = liveStill.type === "image/heic";
          setAlbumProgress({ uploaded: 0, total: liveClip.size + (heic ? liveStill.size : 0), canCancel: true });
          try {
            const photo = heic ? liveStill : await preparePhoto(liveStill);
            if (controller.signal.aborted) return "cancelled";
            const captionFormat = liveFormatting.captionFormat;
            return await sendLivePhoto(liveCaption.trim(), photo, liveClip, controller.signal, (uploaded, total, canCancel) => {
              if (active.current) setAlbumProgress({ uploaded, total, canCancel });
            }, delivery, captionFormat ? { ...liveOptions, captionFormat } : liveOptions);
          } finally {
            albumUpload.current = undefined;
            if (active.current) setAlbumProgress(undefined);
          }
        });
      }}>{deliveryTime ? tr("Schedule live photo") : tr("Send live photo")}</button>
    </fieldset>}
    {fileKind && canSendMediaFile && (fileKind === "audio" ? audio : otherMedia) && <fieldset>
      <legend>{fileKind === "audio" ? tr("Audio attachment") : tr("GIF attachment")}</legend>
      <label>{fileKind === "audio" ? tr("Choose MP3 or M4A") : tr("Choose GIF, MP4 or QuickTime video")}
        <input type="file" disabled={busy} accept={fileKind === "audio" ? ".mp3,.m4a,audio/mpeg,audio/mp4" : ".gif,image/gif," + videoAttachmentAccept}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const validName = (fileKind === "audio" ? isAudioAttachmentName : isChatAnimationAttachmentName)(file.name);
            if (!validName || !file.size || file.size > maxTelegramUploadBytes || file.name.length > 255) {
              setStatus(tr("Choose a supported {0} within Telegram’s upload limit.", [fileLabel]));
              return;
            }
            setGifTrim(undefined);
            setMediaFile(file);
            setStatus("");
          }} />
      </label>
      {mediaFile && <>
        <p><bdi>{mediaFile.name}</bdi> · {formatSize(mediaFile.size)}</p>
        <MediaCaptionEditor label={fileKind === "audio" ? tr("Audio caption") : tr("GIF caption")} input={gifCaptionInput}
          value={gifCaption} formatting={gifFormatting} disabled={busy} change={setGifCaption} groupEmoji={groupEmoji} />
        {fileKind === "animation" && <>
          <EditDraftAnimation file={mediaFile} value={gifTrim} disabled={busy} apply={setGifTrim} />
          <MediaSendControls kind="GIF" options={gifOptions} hasCaption={!!gifCaption.trim()} disabled={busy} change={setGifOptions} />
        </>}
        {fileProgress && <div>
          <progress aria-label={tr("Media file upload to BB")} max={mediaFile.size} value={fileProgress.uploaded} />
          {fileProgress.canCancel && <button type="button" className="mtg-action"
            onClick={() => albumUpload.current?.abort()}>{tr("Cancel upload")}</button>}
        </div>}
        <button type="button" className="mtg-action" disabled={busy || whenOnline && !onlineAllowed} onClick={() =>
          void submit(async (delivery) => {
            const controller = new AbortController();
            albumUpload.current = controller;
            setFileProgress({ uploaded: 0, canCancel: true });
            try {
              return await canSendMediaFile(mediaFile, gifCaption.trim(), controller.signal, (uploaded, canCancel) => {
                if (active.current) setFileProgress({ uploaded, canCancel });
              }, delivery, { ...gifOptions, captionFormat: gifFormatting.captionFormat, mediaKind: fileKind,
                ...(fileKind === "animation" && gifTrim && { animationTrim: gifTrim }) });
            } finally {
              albumUpload.current = undefined;
              if (active.current) setFileProgress(undefined);
            }
          })}>{scheduledMedia ? tr("Schedule") : tr("Send")} {fileLabel}</button>
      </>}
    </fieldset>}
    {panel === "rich" && sendRichMessage && actions.richMessageLimits && <RichMessageComposer load={actions.richMessageLimits}
      disabled={switchDisabled} scheduled={!!deliveryTime} restoreRequest={restoreRichRequest} focusOnOpen={focusRestoredRich} groupEmoji={groupEmoji}
      exchangeDraft={draftStash && paidMessageStars === undefined ? exchangeFormattedDraft : undefined} savedDraft={{
        blocks: richBlocks,
        update: (change) => setRichDrafts((previous) => ({ ...previous, [richDraftKey]: change(previous[richDraftKey]) })),
      }} send={(draft, files) => void submit(async (delivery) => {
        const controller = new AbortController();
        albumUpload.current = controller;
        try {
          const send = richReply && draftContext
            ? draftContext.actionsForReply(composerMediaReply(richReply.reply)).sendRichMessage
            : sendRichMessage;
          if (!send || !active.current) return "failed";
          const result = await send(draft, files, controller.signal, (uploaded, total, canCancel) => {
            if (active.current) setAlbumProgress({ uploaded, total, canCancel });
          }, delivery);
          if (result === "sent" && richReply) setRichReplies((previous) => {
            if (previous[richDraftKey] !== richReply) return previous;
            const next = { ...previous };
            delete next[richDraftKey];
            return next;
          });
          if (result === "sent") setRichDrafts((previous) => {
            if (!richBlocks || previous[richDraftKey] !== richBlocks) return previous;
            const next = { ...previous };
            delete next[richDraftKey];
            return next;
          });
          return result;
        } finally {
          albumUpload.current = undefined;
          if (active.current) setAlbumProgress(undefined);
        }
      }, richReply)} />}
    {panel === "rich" && albumProgress && <div>
      <progress aria-label={tr("Formatted message upload progress")} max={albumProgress.total} value={albumProgress.uploaded} />
      {albumProgress.canCancel && <button type="button" className="mtg-action" onClick={() => albumUpload.current?.abort()}>{tr("Cancel upload")}</button>}
    </div>}
    {panel === "checklist" && sendChecklist && actions.checklistAvailability && <ChecklistComposer load={actions.checklistAvailability}
      disabled={switchDisabled} scheduled={!!deliveryTime} send={(draft) => void submit((delivery) => sendChecklist(draft, delivery))} />}
    {panel === "contact" && sendContactCard && <ContactCardComposer disabled={switchDisabled}
      scheduled={!!deliveryTime} send={(contact) => void submit((delivery) => sendContactCard(contact, delivery))} />}
    {panel === "location" && sendLocation && <form className="mtg-media-attachment-form" onSubmit={(event) => {
      event.preventDefault();
      if (point && !switchDisabled) void submit((delivery) => sendLocation(point, delivery));
    }}>
      <label>{tr("Latitude ")}<input type="number" step="any" min={-90} max={90} required
        value={latitude} disabled={busy} onChange={(event) => setLatitude(event.currentTarget.value)} /></label>
      <label>{tr("Longitude ")}<input type="number" step="any" min={-180} max={180} required
        value={longitude} disabled={busy} onChange={(event) => setLongitude(event.currentTarget.value)} /></label>
      <button type="submit" className="mtg-action" disabled={!point || switchDisabled}>{deliveryTime ? tr("Schedule location") : tr("Send location")}</button>
    </form>}
    {(panel === "sticker" || panel === "gif") && <>
      {search && <div className="mtg-media-choices">
        <input type="search" aria-label={panel === "sticker" ? tr("Search stickers") : tr("Search GIFs")}
          placeholder={panel === "sticker" ? tr("Search stickers") : tr("Search GIFs")} value={searchQuery} maxLength={80}
          disabled={busy} onChange={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            void findMedia();
          }} />
        <button type="button" className="mtg-action" disabled={busy || !searchQuery.trim()} onClick={() => void findMedia()}>{panel === "sticker" ? tr("Find stickers") : tr("Find GIFs")}</button>
        {submittedQuery && <button type="button" className="mtg-action" disabled={busy} onClick={() => void open(panel)}>{panel === "sticker" ? tr("Recent and favorites") : tr("Saved GIFs")}</button>}
      </div>}
      {panel === "sticker" && !packId && !submittedQuery && actions.clearRecentStickers &&
        <div className="mtg-media-choices">
          {confirmClearRecent ? <div role="group" aria-label={tr("Clear recent stickers")}>
            <p>{tr("Clear the history of recently sent stickers?")}</p>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirmClearRecent(false)}>{tr("Cancel")}</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => void clearRecentStickers()}>{tr("Confirm clearing recent stickers")}</button>
          </div> : <button type="button" className="mtg-action" disabled={busy}
            onClick={() => setConfirmClearRecent(true)}>{tr("Clear recent stickers")}</button>}
        </div>}
      {panel === "sticker" && actions.stickerPackDiscovery && <StickerPackDiscovery actions={actions.stickerPackDiscovery}
        onInstalled={() => { if (packs) void browsePacks(); }} />}
      {panel === "sticker" && actions.stickerPackLibrary && <StickerPackLibrary actions={actions.stickerPackLibrary}
        onChanged={() => { void open("sticker"); }} />}
      {panel === "sticker" && groupStickers && actions.groupStickerPage && actions.sendGroupSticker &&
        <div className="mtg-media-choices">
          <button type="button" className="mtg-action" disabled={busy || loadingPackPage} onClick={() => void openPack(undefined, 0, true)}>{tr("Group sticker pack")}</button>
          {groupPackTitle && <p><bdi>{groupPackTitle}</bdi></p>}
          {groupPackTitle && <button type="button" className="mtg-action" disabled={busy} onClick={() => void open("sticker")}>{tr("Recent and favorites")}</button>}
        </div>}
      {panel === "sticker" && actions.stickerPacks && actions.stickerPackPage && <div className="mtg-media-choices">
        {packs === undefined ? <button type="button" className="mtg-action" disabled={busy || loadingPacks}
          onClick={() => void browsePacks()}>{loadingPacks ? tr("Loading sticker packs…") : tr("Installed sticker packs")}</button>
          : packs.length === 0 ? <p>{tr("No installed sticker packs.")}</p>
          : <label>{tr("Sticker pack ")}<select value={groupPackTitle ? "" : packId ?? ""} disabled={busy || loadingPackPage} onChange={(event) => {
            const id = event.currentTarget.value;
            if (id) void openPack(id);
            else void open("sticker");
          }}>
            <option value="">{tr("Recent and favorites")}</option>
            {packs.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select></label>}
        {packs && packs.length > 1 && actions.reorderStickerPacks && (editingPackOrder
          ? <StickerPackOrder packs={packs} save={actions.reorderStickerPacks}
            onSaved={(current, next) => setPacks((previous) => previous === current ? next : previous)}
            reload={() => { setEditingPackOrder(false); void browsePacks(); }}
            close={() => setEditingPackOrder(false)} />
          : <button type="button" className="mtg-action" disabled={busy} onClick={() => setEditingPackOrder(true)}>{tr("Reorder sticker packs")}</button>)}
      </div>}
      <div className="mtg-media-choices" aria-label={panel === "sticker"
        ? submittedQuery ? tr("Sticker search results") : packId ? tr("Stickers in pack") : tr("Recent and favorite stickers") : submittedQuery ? tr("GIF search results") : tr("Saved GIFs")}>
        {!choices && <p role="status">{tr("Loading…")}</p>}
        {choices?.length === 0 && !status && <p>{panel === "sticker" ? submittedQuery ? tr("No matching stickers.") : packId ? tr("No stickers in this pack.") : tr("No recent or favorite stickers.") : submittedQuery ? tr("No matching GIFs.") : tr("No saved GIFs.")}</p>}
        {choices && <MediaChoiceButtons choices={choices} selectedId={selected?.id} disabled={busy} select={setSelected} />}
      </div>
      {packId && moreStickers !== null && <button type="button" className="mtg-action" disabled={busy || loadingPackPage}
        onClick={() => void openPack(packId, moreStickers, !!groupPackTitle)}>{loadingPackPage ? tr("Loading stickers…") : tr("More stickers")}</button>}
      {panel === "gif" && selected && canEditSelectedGif && <div>
        <MediaCaptionEditor label={tr("GIF caption")} value={gifCaption} input={gifCaptionInput} formatting={gifFormatting}
          disabled={busy} change={setGifCaption} groupEmoji={groupEmoji} />
        <MediaSendControls kind="GIF" options={gifOptions} hasCaption={!!gifCaption.trim()} disabled={busy} change={setGifOptions} />
      </div>}
      {panel === "gif" && selected && !canEditSelectedGif && <p>{tr("This result only supports sending directly from search.")}{gifHasEdits && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
          setGifCaption("");
          gifFormatting.reset();
          setGifOptions(undefined);
        }}>{tr("Discard GIF edits")}</button>}
      </p>}
      {selected && <button type="button" className="mtg-action" disabled={busy || (gifHasEdits && !canEditSelectedGif)}
        onClick={() => void submit((delivery) => {
          const gif = gifHasEdits ? { ...gifOptions, caption: gifCaption.trim(),
            ...(gifFormatting.captionFormat ? { captionFormat: gifFormatting.captionFormat } : {}) } : undefined;
          if (selected.gifToken && actions.sendFoundGif) {
            if (gif) return actions.sendFoundGif(selected.gifToken, delivery, gif);
            return delivery ? actions.sendFoundGif(selected.gifToken, delivery) : actions.sendFoundGif(selected.gifToken);
          }
          if (panel === "sticker" && packId && groupPackTitle && actions.sendGroupSticker) {
            return actions.sendGroupSticker(packId, selected.id, delivery);
          }
          if (panel === "gif" && !selected.gifToken && gif) {
            return actions.sendChoice(panel, selected.id, undefined, undefined, delivery, gif);
          }
          const query = panel === "sticker" ? submittedQuery : undefined;
          if (delivery) return actions.sendChoice(panel, selected.id, query, packId, delivery);
          if (packId) return actions.sendChoice(panel, selected.id, undefined, packId);
          return query ? actions.sendChoice(panel, selected.id, query) : actions.sendChoice(panel, selected.id);
        })}>{deliveryTime ? tr("Schedule") : tr("Send")} {panel === "gif" ? "GIF" : tr("sticker")}</button>}
    </>}
    {(panel === "album" || fileAlbum) && <>
      <label>{album.length ? tr("Add") : tr("Choose")}{tr(" album ")}{documents ? tr("documents") : audioAlbum ? tr("audio tracks") : canAlbumVideo ? tr("media") : tr("photos")}
        <input ref={albumPicker} type="file" multiple accept={documents ? undefined : audioAlbum ? ".mp3,.m4a,audio/mpeg,audio/mp4" : [photos && photoAccept, canAlbumVideo && videoAttachmentAccept].filter(Boolean).join(",")} disabled={busy || album.length >= 10}
          aria-keyshortcuts={canExchangeAlbum ? "Control+S" : undefined}
          onKeyDown={canExchangeAlbum ? handleAlbumDraftKey : undefined}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            addAlbumFiles(files);
          }} />
      </label>
      {!fileAlbum && canAlbumMotion && <label>{tr("Import Motion Photos into album")}<input type="file" multiple accept="image/jpeg,image/avif,image/heic,.jpg,.jpeg,.avif,.heic" disabled={busy || album.length >= 10}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void addAlbumMotionPhotos(files);
          }} />
      </label>}
      {canExchangeAlbum && <button type="button" className="mtg-action" onClick={exchangeAlbumDraft}>{tr("Exchange album draft")}</button>}
      {album.length > 0 && <div>
        <ol className="mtg-album-order" data-individual-captions={separateCaptions || undefined}
          aria-label={documents ? tr("Album document order") : audioAlbum ? tr("Album audio order") : canAlbumVideo ? tr("Album media order") : tr("Album photo order")}>
          {album.map(({ id, file, kind, motion, editedPhoto, videoEdit, caption: itemCaption }, index) => <li key={id}>
            {kind === "photo" && file.type !== "image/heic" && (editedPhoto
              ? <img className="mtg-attachment-preview" src={`data:image/jpeg;base64,${editedPhoto}`} alt="" />
              : <AttachmentPhotoPreview file={file} />)}
            <bdi>{file.name}</bdi>
            {kind === "photo" && !motion && isPhotoMimeType(file.type) && <EditDraftPhoto source={editedPhoto ?? file}
              label={tr("Edit album photo {0}", [index + 1])} disabled={busy} apply={(data) =>
                setAlbum((previous) => previous.map((item) =>
                  item.id === id && item.file === file && !item.motion && item.editedPhoto === editedPhoto
                    ? { ...item, editedPhoto: data } : item))} />}
            {editedPhoto && <button type="button" className="mtg-action" aria-label={tr("Reset edits to photo {0}", [index + 1])} disabled={busy}
              onClick={() => setAlbum((previous) => previous.map((item) => item.id === id ? { ...item, editedPhoto: undefined } : item))}>{tr("Reset edits")}</button>}
            {kind === "video" && (!paidAlbum || videoEdit) && <EditDraftVideo file={file} value={videoEdit}
              itemLabel={`album video ${index + 1}`} disabled={busy} apply={(edit) =>
                setAlbum((previous) => previous.map((item) =>
                  item.id === id && item.file === file && item.videoEdit === videoEdit ? { ...item, videoEdit: edit } : item))} />}
            {motion && <bdi>{motion.name}</bdi>}
            {kind === "photo" && !editedPhoto && canAlbumMotion && <label>{motion ? tr("Replace") : tr("Add")}{tr(" motion clip")}<input type="file" accept={videoAttachmentAccept} disabled={busy} onChange={(event) => {
                const clip = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!clip) return;
                if (!isVideoAttachmentName(clip.name) || !clip.size || clip.size > maxTelegramUploadBytes) {
                  setStatus("Choose a non-empty MP4 or MOV clip within Telegram’s file size limit.");
                  return;
                }
                setAlbum((previous) => previous.map((item) => item.id === id ? { ...item, motion: clip } : item));
                setStatus("");
              }} />
            </label>}
            {motion && file.type !== "image/heic" && <button type="button" className="mtg-action" disabled={busy}
              onClick={() => setAlbum((previous) => previous.map((item) => item.id === id ? { ...item, motion: undefined } : item))}>{tr("Remove motion clip")}</button>}
            <button type="button" className="mtg-action" aria-label={tr("Move {0} {1} up", [kind, index + 1])}
              disabled={busy || index === 0} onClick={() => moveAlbumPhoto(index, -1)}>↑</button>
            <button type="button" className="mtg-action" aria-label={tr("Move {0} {1} down", [kind, index + 1])}
              disabled={busy || index === album.length - 1} onClick={() => moveAlbumPhoto(index, 1)}>↓</button>
            <button type="button" className="mtg-action" aria-label={tr("Remove {0} {1}", [kind, index + 1])} disabled={busy}
              onClick={() => {
                setAlbum((previous) => previous.filter((photo) => photo.id !== id));
                itemFormatting.update(({ [id]: _removed, ...remaining }) => remaining);
                setStatus("");
              }}>×</button>
            {separateCaptions && <AlbumFileCaption id={String(id)} input={index === 0 ? albumCaptionInput : undefined}
              label={tr("Caption for file {0}", [index + 1])} text={itemCaption ?? ""} storage={itemFormatting}
              disabled={busy || !canUseSeparateCaptions} groupEmoji={groupEmoji}
              exchangeDraft={canExchangeAlbum ? handleAlbumDraftKey : undefined}
              change={(text) => setAlbum((previous) => previous.map((item) => item.id === id ? { ...item, caption: text } : item))} />}
          </li>)}
        </ol>
        {(canUseSeparateCaptions || separateCaptions) && <label>
          <input type="checkbox" checked={separateCaptions} disabled={busy}
            onChange={(event) => setSeparateCaptions(event.currentTarget.checked)} />{tr(" Individual captions")}</label>}
        {separateCaptions && !canUseSeparateCaptions && <p>{tr("Choose an album caption to send this album.")}</p>}
        {!separateCaptions && <MediaCaptionEditor label={tr("Album caption")} value={caption} input={albumCaptionInput} formatting={albumFormatting}
          disabled={busy} change={setCaption} groupEmoji={groupEmoji} exchangeDraft={canExchangeAlbum ? handleAlbumDraftKey : undefined} />}
        {!fileAlbum && <MediaSendControls kind={canAlbumVideo ? "album media" : "photos"} options={albumOptions} hasCaption={hasAlbumCaption}
          allowOriginalVideo={hasUneditedAlbumVideo && !paidAlbum}
          originalVideoLabel={hasEditedAlbumVideo ? "Original quality for unedited videos" : undefined}
          disabled={busy} change={setAlbumOptions} />}
        {!fileAlbum && !hasAlbumMotion && !albumReply?.reply?.origin && (paidLimit !== null || priceDraft !== "") && <label>{tr("Price in Stars")}<input type="number" min={1} max={paidLimit ?? undefined} step={1} value={priceDraft} disabled={busy || separateCaptions || whenOnline}
            placeholder={tr("Free")} onChange={(event) => setPriceDraft(event.target.value)} />
        </label>}
        {!fileAlbum && paidAlbum && hasEditedAlbumVideo && <p>{tr("Reset the video edits to send this as a paid album.")}</p>}
        {!fileAlbum && paidStars !== undefined && albumOptions?.spoiler && <p>{tr("Remove the spoiler to publish this as paid media.")}</p>}
      </div>}
      {albumProgress && <div>
        <progress aria-label={tr("Album upload progress")} max={albumProgress.total} value={albumProgress.uploaded} />
        {albumProgress.canCancel && <button type="button" className="mtg-action" onClick={() => albumUpload.current?.abort()}>{tr("Cancel album upload")}</button>}
      </div>}
      {!fileAlbum && albumCost !== undefined && album.length >= 2 && <p>
        {deliveryTime ? tr("Paid messages cannot be scheduled.")
          : albumCost > maxPaidAlbumStars ? tr("This album exceeds Telegram’s Stars limit.")
            : tr("{0} Stars per item, {1} Stars total", [paidMessageStars, albumCost])}
      </p>}
      {albumEffects && canApplyAlbumEffect && album.length >= 2 && <MessageEffectPicker
        {...albumEffects} subject="album" selected={albumEffect} choose={setAlbumEffect} disabled={busy} />}
      <button type="button" className="mtg-action" disabled={busy || whenOnline && !onlineAllowed || !canSendAlbumFiles || paidAlbum && hasEditedAlbumVideo || (separateCaptions && !canUseSeparateCaptions) || hasAlbumMotion && !canAlbumMotion || (fileAlbum
        ? !(documents ? canAlbumDocuments : canAlbumAudio) || album.length < 2
        : album.length < (paidStars === undefined ? 2 : 1) || invalidPaidPrice
          || (albumCost !== undefined && (albumCost > maxPaidAlbumStars || !!deliveryTime || paidStars !== undefined)))} onClick={() =>
        void submit(async (delivery) => {
          if (paidAlbum && hasEditedAlbumVideo || paidMessageStars !== undefined && (delivery?.at !== undefined || paidStars !== undefined)) return "failed";
          const effect = canApplyAlbumEffect ? albumEffect?.id : undefined;
          const albumDelivery = paidMessageStars !== undefined ? { ...delivery, paidStars: paidMessageStars }
            : effect !== undefined ? { ...delivery, effect } : delivery;
          const sharedCaption = separateCaptions ? "" : caption.trim();
          const formats = itemFormatting.getSnapshot();
          const itemCaptions = separateCaptions && hasAlbumCaption ? album.map(({ id, caption: text = "" }) => {
            const saved = formats[id];
            const caption = text.trim();
            if (!caption || saved?.text !== text) return caption;
            const format = captionFormatForRanges(trimDraftRanges(text, saved.ranges),
              trimDraftRanges(text, saved.links).map(({ offset, length, url }) => ({ offset, length, url })),
              trimDraftRanges(text, saved.customEmoji ?? []));
            return format ? { text: caption, format } : caption;
          }) : undefined;
          const captionFormat = separateCaptions ? undefined : albumFormatting.captionFormat;
          let presentation = fileAlbum ? undefined : albumOptions;
          if (presentation?.originalVideo !== undefined && (!hasUneditedAlbumVideo || paidAlbum)) {
            const { originalVideo: _unused, ...otherOptions } = presentation;
            presentation = Object.keys(otherOptions).length ? otherOptions : undefined;
          }
          const mediaOptions = paidStars !== undefined || captionFormat || itemCaptions
            ? { ...presentation, ...(paidStars !== undefined ? { paidStars } : {}), ...(captionFormat ? { captionFormat } : {}),
              ...(itemCaptions ? { itemCaptions } : {}) }
            : presentation;
          const items: LocalAlbumItem[] = [];
          for (const { file, kind, motion, editedPhoto, videoEdit } of album) items.push(kind === "video" ? { kind, file, videoEdit }
            : kind === "document" || kind === "audio" ? { kind, file } : motion ? { kind: "livePhoto", file: motion, photo: file.type === "image/heic" ? file : await preparePhoto(file) }
            : { kind, base64: editedPhoto ?? await preparePhoto(file) });
          if (!active.current) return "failed";
          const albumActions = albumReply && draftContext ? draftContext.actionsForReply(composerMediaReply(albumReply.reply)) : actions;
          if (items.some(({ kind }) => kind !== "photo")) {
            if (fileAlbum ? !(documents ? canAlbumDocuments : canAlbumAudio) : items.some(({ kind }) => kind === "video") && !canAlbumVideo
              || hasAlbumMotion && !canAlbumMotion) return "failed";
            if (!albumActions.sendMixedAlbum || !active.current) return "failed";
            const controller = new AbortController();
            albumUpload.current = controller;
            try {
              return await albumActions.sendMixedAlbum(sharedCaption, items, controller.signal, (uploaded, total, canCancel) => {
                if (active.current) setAlbumProgress({ uploaded, total, canCancel });
              }, albumDelivery, mediaOptions);
            } finally {
              albumUpload.current = undefined;
              if (active.current) setAlbumProgress(undefined);
            }
          }
          const photos = items.flatMap((item) => item.kind === "photo" ? [item.base64] : []);
          if (itemCaptions || captionFormat || paidStars !== undefined || albumOptions?.spoiler || (sharedCaption && albumOptions?.captionAbove)) {
            return albumActions.sendAlbum(sharedCaption, photos, albumDelivery, mediaOptions);
          }
          return albumDelivery ? albumActions.sendAlbum(sharedCaption, photos, albumDelivery) : albumActions.sendAlbum(sharedCaption, photos);
        }, albumReply)}>{fileAlbum ? tr("{0} {1} album", [scheduledMedia ? "Schedule" : "Send", documents ? "document" : "audio"])
          : albumCost !== undefined && album.length >= 2 ? tr("Send album for {0} Stars", [albumCost]) : paidStars === undefined ? scheduledMedia ? tr("Schedule album") : tr("Send album")
          : tr("{0} {1} for {2} Stars", [deliveryTime ? "Schedule" : "Publish", album.length === 1 ? album[0]!.kind : "album", paidStars.toLocaleString(uiLocale)])}</button>
    </>}
    {panel === "voice" && <VoiceNoteControls note={note} capture={capture} disabled={busy} scheduled={!!deliveryTime}
      record={() => record("voice")} choose={(file) => void chooseVoice(file)}
      change={(trim) => setNote((current) => current && { ...current, trim })}
      send={(recording) => void submit(async (delivery) => {
        const base64 = await encodeRecording(recording.blob, maxVoiceBytes);
        if (recording.trim) return actions.sendVoice(base64, recording.seconds, recording.format, delivery, recording.trim);
        return delivery ? actions.sendVoice(base64, recording.seconds, recording.format, delivery)
          : actions.sendVoice(base64, recording.seconds, recording.format);
      })} />}
    {panel === "video" && actions.sendVideoNote && <VideoNoteControls note={video} capture={capture} disabled={busy}
      scheduled={!!deliveryTime} record={() => record("video")} change={setVideo} status={setStatus}
      send={(recording) => void submit(async (delivery) =>
        actions.sendVideoNote!(await encodeRecording(recording.blob, maxVideoNoteBytes), recording.format, delivery))} />}
    {status && <p role="status">{tr(status)}</p>}
  </div>;
}

export function AttachmentPhotoPreview({ file, alt = "" }: { file: File; alt?: string }) {
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return preview?.file === file
    ? <img className="mtg-attachment-preview" src={preview.url} alt={alt} loading="lazy" />
    : null;
}
