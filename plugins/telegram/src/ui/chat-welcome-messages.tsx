import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { contactDraft, editableRichDraft, welcomeMediaUpload, welcomeRichEditDraft, type ChatWelcomeMessageChange, type CustomEmojiMedia, type DocumentSender, type PhotoSize,
  type QuickReplyDocumentResult, type RichAttachmentReference, type TelegramPhoto, type UploadRejection,
  type WelcomeCardDraft, type WelcomeMediaUpload, type WelcomeRichComposeDraft, type WelcomeRichUpload, type schemas } from "../core/contract.ts";
import { sameDraftLinks, sameDraftStyles } from "../core/draft-formatting.ts";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import { MessageText } from "./message-text.tsx";
import { PhotoPreview } from "./photo-preview.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { ContactCardFields } from "./contact-card-composer.tsx";
import { LocationCardFields, parseLocationCardFields } from "./location-card-fields.tsx";
import { LocationCard } from "./location-card.tsx";
import { SharedContactCard } from "./shared-contact.tsx";
import { StickerArtwork } from "./custom-emoji.tsx";
import { InstalledStickerPicker, type StickerChoice, type StickerPacks, type StickerPage } from "./installed-sticker-picker.tsx";
import { MediaPlayer } from "./media-player.tsx";
import { DocumentButton } from "./document-button.tsx";
import { embeddedPlaybackId, RichMessage, type RichDocumentBlock, type RichPhotoLoader } from "./rich-message.tsx";
import { RichMessageComposer, type RichMessageComposerActions } from "./rich-message-composer.tsx";
import type { LoadGroupEmoji } from "./group-emoji-picker.tsx";

type Messages = z.infer<typeof schemas.chatWelcomeMessages.output>;
type WelcomeMessage = NonNullable<Messages>[number];
type AttachmentKind = NonNullable<WelcomeMessage["replaceAttachmentKind"]>;
type WelcomeUploadResult = (QuickReplyDocumentResult & { rejection?: UploadRejection }) | { state: "cancelled" | "unknown" };
type UploadWelcomeMedia = (input: WelcomeMediaUpload, file: File, progress: Parameters<DocumentSender>[3], signal: AbortSignal) => Promise<WelcomeUploadResult>;
type RichUploadProgress = (offset: number, total: number, canCancel: boolean) => void;
type LoadGifs = () => Promise<z.infer<typeof schemas.mediaChoices.output>>;
type LoadPlayback = (id: string, messageId: number, revision: string, attachment?: RichAttachmentReference) => Promise<string>;
type WelcomeStickerActions = {
  list: StickerPacks;
  page: StickerPage;
  artwork: (id: string, messageId: number, revision: string) => Promise<CustomEmojiMedia | null>;
};
export type ChatWelcomeMessageActions = {
  load: (id: string) => Promise<Messages>;
  loadPhoto?: (id: string, messageId: number, revision: string, size?: PhotoSize, attachment?: RichAttachmentReference) => Promise<TelegramPhoto>;
  stickers?: WelcomeStickerActions;
  listGifs?: LoadGifs;
  playback?: LoadPlayback;
  saveDocument?: (id: string, messageId: number, revision: string, attachment?: RichAttachmentReference) => Promise<boolean>;
  upload?: UploadWelcomeMedia;
  uploadRich?: (id: string, draft: WelcomeRichComposeDraft, files: Blob[], progress: RichUploadProgress, signal: AbortSignal,
    replace?: WelcomeRichUpload["replace"]) => Promise<WelcomeUploadResult>;
  richLimits?: RichMessageComposerActions["richMessageLimits"];
  change: (input: ChatWelcomeMessageChange) => Promise<z.infer<typeof schemas.changeChatWelcomeMessage.output>>;
};

export function ChatWelcomeMessages({ chatId, actions, loadGroupEmoji }: {
  chatId: string; actions: ChatWelcomeMessageActions; loadGroupEmoji?: LoadGroupEmoji;
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [messages, setMessages] = useState<Messages>();
  const [editor, setEditor] = useState<"add" | "contact" | "location" | "sticker" | "gif" | "rich" | WelcomeMessage>();
  const [attachment, setAttachment] = useState<"add" | WelcomeMessage>();
  const uploadController = useRef<AbortController | undefined>(undefined);
  const [uploadProgress, setUploadProgress] = useState<{ offset: number; size: number; canCancel: boolean }>();
  const [deleting, setDeleting] = useState<WelcomeMessage>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => () => uploadController.current?.abort(), []);

  async function refresh() {
    setMessages(await actions.load(chatId));
    setEditor(undefined);
    setAttachment(undefined);
    setDeleting(undefined);
    setStale(false);
  }

  async function run(work: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  function save(change: ChatWelcomeMessageChange) {
    if (stale) return;
    void run(async () => {
      setStale(true);
      const result = await actions.change(change);
      if (result === "saved") {
        setEditor(undefined);
        setDeleting(undefined);
        setNotice(change.action === "delete" ? "Welcome message deleted." : "Welcome message saved.");
        await refresh();
      } else if (result === "changed") {
        setError("This welcome message changed. Reload the list before editing it again.");
      } else if (result === "invalid") {
        setStale(false);
        setError("Check the welcome message fields before saving.");
      } else if (result === "unavailable") {
        setError("Telegram refused the change. Reload the list to check the current permissions and messages.");
      } else {
        setError("Could not confirm the change. Reload welcome messages before retrying.");
      }
    }, "Could not confirm the current welcome messages. Reload the list.");
  }

  function uploadAttachment(input: WelcomeMediaUpload, file: File) {
    const send = actions.upload;
    if (!send) return;
    upload(file.size, (progress, signal) => send(input, file, (offset, canCancel = true) => progress(offset, file.size, canCancel), signal));
  }

  function upload(size: number, send: (progress: RichUploadProgress, signal: AbortSignal) => Promise<WelcomeUploadResult>) {
    if (stale) return;
    void run(async () => {
      const controller = new AbortController();
      uploadController.current = controller;
      setUploadProgress({ offset: 0, size, canCancel: true });
      setStale(true);
      try {
        const result = await send((offset, total, canCancel) => {
          setUploadProgress({ offset, size: total, canCancel: canCancel && !controller.signal.aborted });
        }, controller.signal);
        if (result.state === "submitted") {
          setNotice("Welcome message saved.");
          await refresh();
        } else if (result.state === "cancelled") {
          setStale(false);
          setNotice("Upload cancelled.");
        } else if (result.state === "failed") {
          setStale(false);
          setError(result.rejection === "premium_required" ? "Telegram Premium is required for files over 2000 MiB."
            : result.rejection === "legacy_tdlib" ? "Update TDLib to upload a file this large."
            : result.rejection === "file_too_large" ? "Telegram supports files up to 4000 MiB."
            : "Could not save the attachment. Your file and caption are still available.");
        } else {
          setError(result.state === "changed" ? "This welcome message changed. Reload the list before replacing it."
            : "Could not confirm the upload. Reload welcome messages before retrying.");
        }
      } finally {
        uploadController.current = undefined;
        setUploadProgress(undefined);
      }
    }, "Could not confirm the upload. Reload welcome messages before retrying.");
  }

  const unavailable = busy || stale;
  const editing = !!editor || !!deleting || !!attachment;
  const editedMessage = typeof editor === "object" ? editor : undefined;
  const editingSticker = editor === "sticker" || !!editedMessage?.sticker;
  const editingRich = editor === "rich" || !!editedMessage?.rich;
  const editingCard = editor === "contact" || editor === "location" || !!editedMessage?.contact || !!editedMessage?.location;
  const cancel = () => setEditor(undefined);
  return <details className="mtg-chat-details-disclosure">
    <summary>{tr("Welcome messages")}</summary>
    <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void run(refresh, "Could not load welcome messages.")}>
      {messages === undefined ? tr("Load welcome messages") : tr("Reload welcome messages")}
    </button>
    {messages === null && <p>{tr("Welcome messages require Telegram support and administrator permission for this chat.")}</p>}
    {messages && <>
      {!messages.length && <p>{tr("No welcome messages.")}</p>}
      <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("add")}>{tr("Add welcome message")}</button>
      <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("contact")}>{tr("Add welcome contact")}</button>
      <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("location")}>{tr("Add welcome location")}</button>
      {actions.stickers && <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("sticker")}>{tr("Add welcome sticker")}</button>}
      {actions.listGifs && <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("gif")}>{tr("Add welcome GIF")}</button>}
      {actions.upload && <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setAttachment("add")}>{tr("Add welcome attachment")}</button>}
      {actions.richLimits && <button type="button" className="mtg-action" disabled={unavailable || editing}
        onClick={() => setEditor("rich")}>{tr("Add formatted welcome")}</button>}
      {!!messages.length && <ol aria-label={tr("Welcome messages")}>{messages.map((message, index) => <li key={message.id}>
        {message.photo && actions.loadPhoto && <WelcomePhoto key={`welcome-photo:${message.revision}`} chatId={chatId} message={message} load={actions.loadPhoto} />}
        {message.playback && actions.playback && <WelcomePlayback key={`welcome-playback:${message.revision}`} chatId={chatId}
          message={message} media={message.playback} load={actions.playback} />}
        {message.document && <DocumentButton key={`welcome-document:${message.revision}`} document={message.document}
          save={message.document.downloadable && actions.saveDocument
            ? () => actions.saveDocument!(chatId, message.id, message.revision) : undefined} />}
        <WelcomeMessageBody chatId={chatId} message={message} stickerArtwork={actions.stickers?.artwork} mediaActions={actions}
          showKind={!message.document && !(message.photo && actions.loadPhoto) && !(message.playback && actions.playback)} />
        {message.editable && (!message.sticker || actions.stickers) && (!message.rich || actions.richLimits)
          && <button type="button" className="mtg-action" disabled={unavailable || editing}
          onClick={() => setEditor(message)}>{tr("Edit welcome message ")}{index + 1}</button>}
        {actions.upload && message.replaceAttachmentKind && <button type="button" className="mtg-action" disabled={unavailable || editing}
          onClick={() => setAttachment(message)}>{tr("Replace welcome attachment ")}{index + 1}</button>}
        <button type="button" className="mtg-action" disabled={unavailable || editing}
          onClick={() => setDeleting(message)}>{tr("Delete welcome message ")}{index + 1}</button>
      </li>)}</ol>}
    </>}
    {editingSticker && actions.stickers && <WelcomeStickerEditor chatId={chatId} message={editedMessage}
      stickers={actions.stickers} unavailable={unavailable} busy={busy} save={save} cancel={cancel} />}
    {editingCard && <WelcomeCardEditor chatId={chatId} kind={editor === "contact" || editedMessage?.contact ? "contact" : "location"}
      message={editedMessage} unavailable={unavailable} busy={busy} save={save} cancel={cancel} />}
    {editingRich && actions.richLimits && <>
      <RichMessageComposer load={actions.richLimits} existingDraft={editedMessage?.richDraft} disabled={unavailable} scheduled={false}
        groupEmoji={loadGroupEmoji ? { id: chatId, load: loadGroupEmoji } : undefined}
        saveExisting={(draft, files) => {
          if (!editedMessage) return;
          const replace = { messageId: editedMessage.id, revision: editedMessage.revision };
          const uploadRich = actions.uploadRich;
          if (files.length && uploadRich) {
            upload(files.reduce((total, file) => total + file.size, 0), (progress, signal) => uploadRich(chatId, draft, files, progress, signal, replace));
            return;
          }
          const parsed = welcomeRichEditDraft.safeParse(draft);
          if (parsed.success) save({ action: "editRich", id: chatId, ...replace, draft: parsed.data });
        }}
        textOnly={!actions.uploadRich} submitLabel={tr("Save welcome message")} cancel={cancel} send={(draft, files) => {
          const uploadRich = actions.uploadRich;
          if (files.length && !editedMessage && uploadRich) {
            upload(files.reduce((total, file) => total + file.size, 0), (progress, signal) => uploadRich(chatId, draft, files, progress, signal));
            return;
          }
          const parsed = editableRichDraft.safeParse(draft);
          if (!parsed.success) return;
          if (!editedMessage) save({ action: "addRich", id: chatId, draft: parsed.data });
        }} />
      <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel")}</button>
    </>}
    {editor && !editingSticker && !editingCard && !editingRich && <WelcomeTextEditor chatId={chatId} message={editedMessage}
      allowPhoto={!!actions.loadPhoto} gifMode={editor === "gif" || !!editedMessage?.gif} listGifs={actions.listGifs}
      busy={busy} stale={stale} save={save} cancel={cancel} />}
    {attachment && <WelcomeAttachmentEditor chatId={chatId} message={attachment === "add" ? undefined : attachment}
      unavailable={unavailable} busy={busy} upload={uploadAttachment} close={() => setAttachment(undefined)} />}
    {uploadProgress && <div>
      <progress aria-label={tr("Welcome attachment upload")} value={uploadProgress.offset} max={uploadProgress.size} />
      <p role="status">{uploadProgress.offset >= uploadProgress.size ? tr("Waiting for Telegram…") : tr("Uploading file to BB…")}</p>
      <button type="button" className="mtg-action" disabled={!uploadProgress.canCancel} onClick={() => {
        uploadController.current?.abort();
        setUploadProgress({ ...uploadProgress, canCancel: false });
      }}>{tr("Cancel upload")}</button>
    </div>}
    {deleting && <div role="group" aria-label={tr("Confirm welcome message deletion")}>
      <p>{tr("Delete this welcome message for the chat?")}</p>
      {deleting.document && <p><bdi>{deleting.document.name}</bdi></p>}
      <WelcomeMessageBody chatId={chatId} message={deleting} showKind={!deleting.document} reviewing />
      <button type="button" className="mtg-action" disabled={unavailable}
        onClick={() => save({ action: "delete", id: chatId, messageId: deleting.id, revision: deleting.revision })}>{tr("Confirm deletion")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setDeleting(undefined)}>{tr("Keep welcome message")}</button>
    </div>}
    {busy && !uploadProgress && <p role="status">{tr("Updating welcome messages…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr(error)}</p>}
  </details>;
}

type WelcomeMediaActions = Pick<ChatWelcomeMessageActions, "loadPhoto" | "playback" | "saveDocument">;

function WelcomeMessageBody({ chatId, message, showKind, reviewing, stickerArtwork, mediaActions }: {
  chatId: string; message: WelcomeMessage; showKind: boolean; reviewing?: boolean;
  stickerArtwork?: WelcomeStickerActions["artwork"]; mediaActions?: WelcomeMediaActions;
}) {
  const messageId = String(message.id);
  if (message.rich) return <WelcomeRichMessage key={message.revision} chatId={chatId} message={message} mediaActions={mediaActions} />;
  if (message.contact) return <SharedContactCard contact={message.contact} chatId={chatId} messageId={messageId} actionable={false} />;
  if (message.location) return <LocationCard location={message.location} chatId={chatId} messageId={messageId} previewAllowed={false} />;
  if (message.sticker) return stickerArtwork
    ? <WelcomeSticker key={message.revision} chatId={chatId} message={message} label={message.sticker.label} artwork={stickerArtwork} />
    : <p><bdi>{message.sticker.label}</bdi></p>;
  if (message.text) return <div dir="auto"><MessageText text={message.text} styles={message.styles} links={reviewing ? undefined : message.links} /></div>;
  return showKind ? <p>{message.kind}</p> : null;
}

function WelcomeRichMessage({ chatId, message, mediaActions }: {
  chatId: string; message: WelcomeMessage; mediaActions?: WelcomeMediaActions;
}) {
  const { id, revision, rich } = message;
  const load = mediaActions?.loadPhoto;
  const loadPhoto = useCallback<RichPhotoLoader>((target, _messageId, size, attachment) => {
    if (!load || !attachment) return Promise.reject(new Error("Embedded photo unavailable."));
    return load(target, id, revision, size, attachment);
  }, [load, id, revision]);
  if (!rich) return null;
  return <RichMessage chatId={chatId} messageId={String(id)} layout={rich} loadPhoto={load ? loadPhoto : undefined}
    renderDocument={mediaActions ? (block) => <WelcomeRichFile key={`${block.reference.index}:${block.reference.fileId}`}
      chatId={chatId} messageId={id} revision={revision} block={block} actions={mediaActions} /> : undefined} />;
}

function WelcomeRichFile({ chatId, messageId, revision, block, actions }: {
  chatId: string; messageId: number; revision: string; block: RichDocumentBlock; actions: WelcomeMediaActions;
}) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  const { document, reference, media } = block;
  const { playback, saveDocument } = actions;
  const { index, fileId } = reference;
  const stream = useCallback(() => playback!(chatId, messageId, revision, { index, fileId }),
    [playback, chatId, messageId, revision, index, fileId]);
  if (block.spoiler && !revealed) return <button type="button" className="mtg-action" onClick={() => setRevealed(true)}>
    {media === "gif" ? tr("Show GIF spoiler") : tr("Show video spoiler")}
  </button>;
  const player = document.downloadable && document.playbackMime && !document.approximateSize && playback
    ? <MediaPlayer chatId={chatId} messageId={embeddedPlaybackId(String(messageId), reference)} mime={document.playbackMime}
      stream={stream} loop={block.loop} voiceNote={media === "voice"} /> : undefined;
  return <DocumentButton document={document} player={player}
    save={document.downloadable && saveDocument ? () => saveDocument(chatId, messageId, revision, { index, fileId }) : undefined} />;
}

function WelcomeSticker({ chatId, message, label, artwork }: {
  chatId: string; message: WelcomeMessage; label: string; artwork: WelcomeStickerActions["artwork"];
}) {
  const { id, revision } = message;
  const load = useCallback(() => artwork(chatId, id, revision), [artwork, chatId, id, revision]);
  return <StickerArtwork id={revision} label={label} load={load} />;
}

function WelcomeStickerEditor({ chatId, message, stickers, unavailable, busy, save, cancel }: {
  chatId: string; message?: WelcomeMessage; stickers: WelcomeStickerActions; unavailable: boolean; busy: boolean;
  save: (change: ChatWelcomeMessageChange) => void; cancel: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [choice, setChoice] = useState<StickerChoice>();
  return <form aria-label={message ? tr("Replace welcome sticker") : tr("Add welcome sticker")} onSubmit={(event) => {
    event.preventDefault();
    if (!choice || unavailable) return;
    const { packId, fileId } = choice;
    save(message ? { action: "editSticker", id: chatId, messageId: message.id, revision: message.revision, packId, fileId }
      : { action: "addSticker", id: chatId, packId, fileId });
  }}>
    <InstalledStickerPicker list={stickers.list} load={stickers.page} busy={unavailable} choose={setChoice} label={tr("Welcome sticker pack")} />
    {choice && <p role="status">{tr("Selected sticker ")}<bdi>{choice.label}</bdi></p>}
    <button type="submit" className="mtg-action" disabled={!choice || unavailable}>{tr("Save welcome message")}</button>
    <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel")}</button>
  </form>;
}

function WelcomeCardEditor({ chatId, kind, message, unavailable, busy, save, cancel }: {
  chatId: string; kind: WelcomeCardDraft["kind"]; message?: WelcomeMessage; unavailable: boolean; busy: boolean;
  save: (change: ChatWelcomeMessageChange) => void; cancel: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [person, setPerson] = useState(message?.contact ?? { firstName: "", lastName: "", phone: "" });
  const [place, setPlace] = useState({
    latitude: message?.location ? String(message.location.latitude) : "",
    longitude: message?.location ? String(message.location.longitude) : "",
    title: message?.location?.place?.title ?? "", address: message?.location?.place?.address ?? "",
  });
  const contact = kind === "contact" ? contactDraft.safeParse(person).data : undefined;
  const location = kind === "location" ? parseLocationCardFields(place) : undefined;
  const card: WelcomeCardDraft | undefined = contact ? { kind: "contact", contact }
    : location ? { kind: "location", ...location } : undefined;

  return <form aria-label={message ? tr("Edit welcome card") : tr("Add welcome card")} onSubmit={(event) => {
    event.preventDefault();
    if (!card || unavailable) return;
    save(message ? { action: "editCard", id: chatId, messageId: message.id, revision: message.revision, card }
      : { action: "addCard", id: chatId, card });
  }}>
    <fieldset disabled={unavailable}>
      <legend>{kind === "contact" ? tr("Welcome contact") : tr("Welcome location")}</legend>
      {kind === "contact" ? <ContactCardFields draft={person} update={setPerson} required />
        : <LocationCardFields draft={place} update={setPlace} />}
    </fieldset>
    <button type="submit" className="mtg-action" disabled={!card || unavailable}>{tr("Save welcome message")}</button>
    <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel")}</button>
  </form>;
}

function WelcomePhoto({ chatId, message, load }: { chatId: string; message: WelcomeMessage; load: NonNullable<ChatWelcomeMessageActions["loadPhoto"]> }) {
  const { id, revision } = message;
  const read = useCallback((target: string, _messageId: string, size?: PhotoSize) => load(target, id, revision, size), [load, id, revision]);
  return <PhotoPreview chatId={chatId} messageId={String(id)} load={read}
    dimensions={message.photo?.dimensions} spoiler={message.photo?.spoiler} />;
}

function WelcomePlayback({ chatId, message, media, load }: {
  chatId: string; message: WelcomeMessage; media: NonNullable<WelcomeMessage["playback"]>; load: LoadPlayback;
}) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  const { id, revision } = message;
  const stream = useCallback(() => load(chatId, id, revision), [load, chatId, id, revision]);
  if (media.spoiler && !revealed) return <button type="button" className="mtg-action" onClick={() => setRevealed(true)}>
    {media.loop ? tr("Show GIF spoiler") : tr("Show video spoiler")}
  </button>;
  return <MediaPlayer chatId={chatId} messageId={String(id)} mime={media.mime} stream={stream}
    loop={media.loop} voiceNote={media.voiceNote} videoNote={media.videoNote} />;
}

function SavedGifPicker({ list, busy, choose }: {
  list: LoadGifs; busy: boolean; choose: (gif: z.infer<typeof schemas.mediaChoices.output>[number]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [choices, setChoices] = useState<Awaited<ReturnType<LoadGifs>> | null>();
  useEffect(() => {
    let active = true;
    void list().then((items) => { if (active) setChoices(items); }, () => { if (active) setChoices(null); });
    return () => { active = false; };
  }, [list]);
  if (choices === undefined) return <p role="status">{tr("Loading saved GIFs…")}</p>;
  if (choices === null) return <p role="alert">{tr("Could not load saved GIFs.")}</p>;
  if (!choices.length) return <p>{tr("No saved GIFs.")}</p>;
  return <div className="mtg-media-choices" role="group" aria-label={tr("Saved GIFs")}>
    {choices.map((gif) => <button key={gif.id} type="button" className="mtg-action" aria-label={tr("Use {0}", [gif.label])} disabled={busy}
      onClick={() => choose(gif)}>{gif.preview ? <img alt="" src={`data:${gif.preview.mime};base64,${gif.preview.base64}`} /> : <bdi>{gif.label}</bdi>}</button>)}
  </div>;
}

function WelcomeTextEditor({ chatId, message, allowPhoto, gifMode, listGifs, busy, stale, save, cancel }: {
  chatId: string; message?: WelcomeMessage; allowPhoto: boolean; gifMode: boolean; listGifs?: LoadGifs; busy: boolean; stale: boolean;
  save: (change: ChatWelcomeMessageChange) => void; cancel: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const input = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(message?.text ?? "");
  const [file, setFile] = useState<File>();
  const [gif, setGif] = useState<z.infer<typeof schemas.mediaChoices.output>[number]>();
  const [pickingGif, setPickingGif] = useState(gifMode && !message);
  const pending = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const originalLinks = message?.links?.filter((link) => link.hidden) ?? [];
  const formatting = useDraftFormatting(chatId, text, input, message?.styles, true, originalLinks);
  const styles = formatting.deliveryStyles;
  const links = formatting.deliveryLinks;
  const normalized = text.trim();
  const unavailable = busy || stale || preparing;
  const photo = !!file || !!message?.photo;
  const caption = photo || gifMode || !!message?.mediaCaption;
  const unchanged = !file && !gif && normalized === message?.text && sameDraftStyles(styles, message.styles ?? []) && sameDraftLinks(links, originalLinks);
  const canSave = (!gifMode || !!message || !!gif) && (caption ? normalized.length <= 1024 : !!normalized);

  return <form aria-label={message ? tr("Edit welcome message") : tr("Add welcome message")} onSubmit={async (event) => {
    event.preventDefault();
    if (pending.current || unavailable || !canSave || unchanged) return;
    pending.current = true;
    setPhotoError("");
    try {
      let photoBase64: string | undefined;
      if (file) {
        setPreparing(true);
        photoBase64 = await preparePhoto(file);
        if (!input.current?.isConnected) return;
      }
      const fields = { id: chatId, text: normalized, ...(styles.length > 0 && { styles }), ...(links.length > 0 && { links }),
        ...(photoBase64 && { photoBase64 }), ...(gif && { gifFileId: gif.id }) };
      save(message ? { ...fields, action: "edit", messageId: message.id, revision: message.revision } : { ...fields, action: "add" });
    } catch { setPhotoError("Could not prepare the selected photo."); }
    finally { pending.current = false; setPreparing(false); }
  }}>
    {gifMode && listGifs && <>
      {gif && <p role="status">{tr("Selected GIF ")}<bdi>{gif.label}</bdi></p>}
      <button type="button" className="mtg-action" aria-expanded={pickingGif} disabled={unavailable}
        onClick={() => setPickingGif(!pickingGif)}>{pickingGif ? tr("Hide saved GIFs") : tr("Choose saved GIF")}</button>
      {pickingGif && <SavedGifPicker list={listGifs} busy={unavailable} choose={(selected) => { setGif(selected); setPickingGif(false); }} />}
      {gif && <button type="button" className="mtg-action" disabled={unavailable} onClick={() => setGif(undefined)}>{tr("Clear selected GIF")}</button>}
    </>}
    {allowPhoto && !gifMode && (!message || message.photo) && <>
      <label>{message ? tr("Replace welcome photo") : tr("Welcome photo (optional)")} <input ref={photoInput}
        type="file" accept={photoAccept} disabled={unavailable} onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          if (selected && (!isPhotoMimeType(selected.type) || selected.size > maxOriginalPhotoBytes)) {
            event.currentTarget.value = "";
            setFile(undefined);
            setPhotoError("Choose a JPEG, PNG or WebP photo up to 64 MiB.");
          } else {
            setFile(selected);
            setPhotoError("");
          }
        }} /></label>
      {file && <button type="button" className="mtg-action" disabled={unavailable} onClick={() => {
        if (photoInput.current) photoInput.current.value = "";
        setFile(undefined);
        setPhotoError("");
      }}>{tr("Remove selected photo")}</button>}
      {photo && !canSave && <p>{tr("Use up to 1024 characters for a photo caption.")}</p>}
    </>}
    <label>{gifMode ? tr("Welcome GIF caption") : photo ? tr("Welcome photo caption") : message?.mediaCaption ? tr("{0} caption", [message.mediaCaption]) : tr("Welcome text")}
      <textarea ref={input} value={text} maxLength={caption ? 1024 : 4096}
      disabled={busy || preparing} readOnly={stale}
      onChange={(event) => { formatting.change(event.target.value); setText(event.target.value); }}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onKeyDown={unavailable ? undefined : formatting.shortcut}
      onPaste={unavailable ? undefined : (event) => formatting.paste(event, setText)} /></label>
    <DraftFormatButton formatting={formatting} busy={unavailable} />
    <DraftFormatControls formatting={formatting} busy={unavailable} />
    <button type="submit" className="mtg-action" disabled={unavailable || !canSave || unchanged}>{tr("Save welcome message")}</button>
    <button type="button" className="mtg-action" disabled={busy || preparing} onClick={cancel}>{tr("Cancel")}</button>
    {preparing && <p role="status">{tr("Preparing welcome photo…")}</p>}
    {photoError && <p role="alert">{tr(photoError)}</p>}
  </form>;
}

const welcomeAttachmentTypes: Record<AttachmentKind, { label: string; accept?: string }> = {
  document: { label: "Document" },
  video: { label: "Video", accept: ".mp4,.mov" },
  audio: { label: "Audio", accept: ".mp3,.m4a" },
  animation: { label: "GIF", accept: ".gif" },
  voice: { label: "Voice note", accept: ".ogg,.opus" },
  videoNote: { label: "Video note", accept: ".mp4,.webm" },
};

function WelcomeAttachmentEditor({ chatId, message, unavailable, busy, upload, close }: {
  chatId: string; message?: WelcomeMessage; unavailable: boolean; busy: boolean;
  upload: (input: WelcomeMediaUpload, file: File) => void; close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [kind, setKind] = useState<AttachmentKind>(message?.replaceAttachmentKind ?? "document");
  const [file, setFile] = useState<File>();
  const [text, setText] = useState(message?.text ?? "");
  const caption = useRef<HTMLTextAreaElement>(null);
  const formatting = useDraftFormatting(chatId, text, caption, message?.styles, true, message?.links?.filter((link) => link.hidden));
  const { label, accept } = welcomeAttachmentTypes[kind];
  const formatted = kind === "videoNote" ? { caption: "" } : { caption: text.trim(),
    styles: formatting.deliveryStyles, links: formatting.deliveryLinks };
  const input = file && welcomeMediaUpload.safeParse({ id: chatId, filename: file.name, size: file.size,
    ...(kind !== "document" && { [kind]: true }), ...formatted,
    ...(message && { replace: { messageId: message.id, revision: message.revision } }),
  }).data;

  return <form aria-label={message ? tr("Replace welcome attachment") : tr("Add welcome attachment")} onSubmit={(event) => {
    event.preventDefault();
    if (input && file && !unavailable) upload(input, file);
  }}>
    {!message && <label>{tr("Attachment type ")}<select value={kind} disabled={unavailable} onChange={(event) => {
      setKind(event.currentTarget.value as AttachmentKind);
      setFile(undefined);
    }}>{(Object.entries(welcomeAttachmentTypes) as [AttachmentKind, { label: string }][]).map(([kind, { label }]) =>
      <option key={kind} value={kind}>{label}</option>)}</select></label>}
    <label>{label}{tr(" file ")}<input key={kind} type="file" accept={accept} disabled={unavailable}
      onChange={(event) => setFile(event.currentTarget.files?.[0])} /></label>
    {file && !input && <p role="alert">{tr("This file or caption is invalid for ")}{label.toLowerCase()}.</p>}
    {kind !== "videoNote" && <>
      <label>{tr("Attachment caption ")}<textarea ref={caption} value={text} maxLength={1024} disabled={unavailable}
        onChange={(event) => { formatting.change(event.currentTarget.value); setText(event.currentTarget.value); }}
        onSelect={(event) => formatting.select(event.currentTarget)}
        onKeyDown={unavailable ? undefined : formatting.shortcut}
        onPaste={unavailable ? undefined : (event) => formatting.paste(event, setText)} /></label>
      <DraftFormatButton formatting={formatting} busy={unavailable} />
      <DraftFormatControls formatting={formatting} busy={unavailable} />
    </>}
    <button type="submit" className="mtg-action" disabled={!input || unavailable}>{tr("Save welcome attachment")}</button>
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr("Cancel")}</button>
  </form>;
}
