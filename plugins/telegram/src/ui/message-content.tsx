import { useId, useState, type ReactNode } from "react";
import { CopyReference } from "./copy-message-reference.tsx";
import type { StickerPackPreviewData, MediaCollectionKind, DocumentInfo, PollChoice, PollInfo, PhotoSize, TelegramPhoto } from "../core/contract.ts";
import { webLink } from "../core/message-links.ts";
import type { Message } from "../core/demo.ts";
import { MessageForward, type ForwardActions } from "./message-forward.tsx";
import { MessageReactions, type ReactionActions } from "./message-reactions.tsx";
import { MediaPlayer, type MediaLoader } from "./media-player.tsx";
import { MessageText } from "./message-text.tsx";
import { PhotoPreview, type AlbumPhoto } from "./photo-preview.tsx";

type StickerPack = StickerPackPreviewData;

export type MediaCollectionActions = {
  loadPack?: (chatId: string, messageId: string, offset: number) => Promise<StickerPack | null>;
  installPack?: (chatId: string, messageId: string, packId: string) => Promise<"installed" | "unavailable" | "unknown">;
  load: (chatId: string, messageId: string, kind: MediaCollectionKind) => Promise<boolean | null>;
  save: (chatId: string, messageId: string, kind: MediaCollectionKind, saved: boolean, expected: boolean) =>
    Promise<"saved" | "changed" | "unavailable" | "unknown">;
};

export function MessageContent({ chatId, message, hideCaption, albumPhotos, loadPhoto, loadMedia, loadVideoStream, transcribeVoice, saveDocument, voteInPoll, stopPoll, reactionActions, forwardActions, mediaCollection }: {
  chatId: string;
  message: Message;
  hideCaption?: boolean;
  albumPhotos?: readonly AlbumPhoto[];
  mediaCollection?: MediaCollectionActions;
  forwardActions?: ForwardActions;
  reactionActions?: ReactionActions;
  stopPoll?: (chatId: string, messageId: string) => Promise<boolean>;
  voteInPoll?: (chatId: string, messageId: string, choices: PollChoice[]) => Promise<boolean>;
  loadMedia?: MediaLoader;
  transcribeVoice?: (chatId: string, messageId: string) => Promise<string>;
  loadVideoStream?: (chatId: string, messageId: string) => Promise<string>;
  saveDocument?: (chatId: string, messageId: string) => Promise<boolean>;
  loadPhoto?: (chatId: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
}) {
  const forwarded = message.forwardedFrom !== undefined && <p className="mtg-forwarded">
    {message.forwardedFrom ? <>Forwarded from <bdi>{message.forwardedFrom}</bdi></> : "Forwarded message"}
  </p>;
  const actionable = !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id);
  const actions = actionable ? reactionActions : undefined;
  const identity = `${chatId}:${message.id}`;
  const forward = actionable && forwardActions && <MessageForward key={`forward:${identity}`}
    chatId={chatId} messageId={message.id} actions={forwardActions} />;
  const reactions = (message.reactions || actions) && <MessageReactions key={`reactions:${identity}`}
    chatId={chatId} messageId={message.id} reactions={message.reactions} actions={actions} />;
  const loadStickerPack = mediaCollection?.loadPack;
  const installStickerPack = mediaCollection?.installPack;
  const collection = actionable && message.collectionKind && mediaCollection &&
    <div>
      <MediaCollection key={`collection:${identity}`} chatId={chatId} messageId={message.id} kind={message.collectionKind} actions={mediaCollection} />
      {message.hasStickerPack && loadStickerPack && <StickerPackPreview key={`pack:${identity}`}
        load={(offset) => loadStickerPack(chatId, message.id, offset)}
        install={installStickerPack && ((id) => installStickerPack(chatId, message.id, id))} />}
    </div>;
  if (message.oneView && loadMedia) {
    return <MediaPlayer key={`one-view:${identity}`} chatId={chatId} messageId={message.id}
      oneView={message.oneView} saved={!!message.retained} load={loadMedia} />;
  }
  if (message.poll) {
    return <>{forwarded}<Poll key={`poll:${identity}`} poll={message.poll}
      stop={actionable && message.canStopPoll && stopPoll ? () => stopPoll(chatId, message.id) : undefined}
      vote={voteInPoll ? (choices) => voteInPoll(chatId, message.id, choices) : undefined} />{reactions}{forward}</>;
  }
  if (chatId && message.hasPhoto && loadPhoto) {
    const caption = !hideCaption && <MessageText text={message.photoCaption} links={message.links} styles={message.styles} />;
    return <>
      {forwarded}
      {message.captionAboveMedia && caption}
      <PhotoPreview key={`photo:${identity}:${message.photoSpoiler === true}`}
        chatId={chatId} messageId={message.id} load={loadPhoto} spoiler={message.photoSpoiler} album={albumPhotos} canSave={message.canSavePhoto} save={saveDocument} dimensions={message.photoDimensions} />
      {!message.captionAboveMedia && caption}
      {collection}{reactions}{forward}
    </>;
  }
  if (message.document) {
    const caption = !hideCaption && <MessageText text={message.document.caption} links={message.links} styles={message.styles} />;
    const media = <>
      {message.document.downloadable && message.document.playbackMime && loadMedia &&
        <MediaPlayer key={`player:${identity}:${message.document.playbackMime}`}
          chatId={chatId} messageId={message.id} mime={message.document.playbackMime} load={loadMedia} loop={message.animation}
          videoNote={message.videoNote}
          stream={message.videoNote || message.document.approximateSize ? undefined : loadVideoStream} />}
      {(message.voiceNote || message.videoNote) && transcribeVoice && <VoiceTranscript key={identity} load={() => transcribeVoice(chatId, message.id)} />}
      <DocumentButton key={`download:${identity}`} document={message.document}
        save={message.document.downloadable && saveDocument ? () => saveDocument(chatId, message.id) : undefined} />
    </>;
    return <>
      {forwarded}
      {message.captionAboveMedia && caption}
      {message.videoSpoiler ? <VideoSpoiler key={`spoiler:${identity}`} animation={message.animation}>
        {media}
      </VideoSpoiler> : media}
      {!message.captionAboveMedia && caption}
      {collection}{reactions}{forward}
    </>;
  }
  const preview = message.linkPreview;
  const link = preview && !message.styles?.some(({ style }) => style === "spoiler") && webLink(preview.url);
  const card = preview && link && <a className="mtg-link-preview" href={link.href} target="_blank" rel="noopener noreferrer">
    <span><bdi>{preview.site || link.hostname}</bdi></span>
    {preview.title && <strong><bdi>{preview.title}</bdi></strong>}
    {preview.description && <span><bdi>{preview.description}</bdi></span>}
    {!!preview.site && <small><bdi>{link.hostname}</bdi></small>}
  </a>;
  return <>{forwarded}{preview?.above && card}
    {!hideCaption && <MessageText text={message.text} links={message.links} styles={message.styles} />}
    {!preview?.above && card}{collection}{reactions}{forward}</>;
}

function VideoSpoiler({ animation, children }: { animation?: boolean; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return revealed ? <>{children}</> : <button type="button" className="mtg-action"
    onClick={() => setRevealed(true)}>{animation ? "Show GIF spoiler" : "Show video spoiler"}</button>;
}

export function StickerPackPreview({ load, install, initial }: {
  initial?: StickerPack;
  load: (offset: number) => Promise<StickerPack | null>;
  install?: (id: string) => Promise<"installed" | "unavailable" | "unknown">;
}) {
  const [pack, setPack] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function show(offset: number) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await load(offset);
      if (!next || (offset && pack?.id !== next.id)) {
        setError("This sticker pack is unavailable.");
        return;
      }
      const choices = offset && pack ? [...pack.choices, ...next.choices.filter(({ id }) => !pack.choices.some((choice) => choice.id === id))] : next.choices;
      setPack({ ...next, choices });
    } catch { setError("Could not load this sticker pack."); }
    finally { setBusy(false); }
  }

  async function add(id: string) {
    if (!install || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await install(id);
      if (result === "installed") setPack((previous) => previous && { ...previous, installed: true });
      else setError(result === "unavailable" ? "This sticker pack is unavailable." : "Telegram did not confirm installation.");
    } catch { setError("Could not confirm installation."); }
    finally { setBusy(false); }
  }

  return <div>
    {!pack ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void show(0)}>
      {busy ? "Loading sticker pack…" : "Open sticker pack"}
    </button> : <div role="group" aria-label="Sticker pack">
      <strong><bdi>{pack.title}</bdi></strong>
      {pack.link && <CopyReference label="Sticker pack link" value={pack.link} buttonClass="mtg-action">Copy sticker pack link</CopyReference>}
      <div className="mtg-media-choices">{pack.choices.map(({ id, preview, label }) =>
        preview ? <img key={id} width="48" height="48" loading="lazy" src={`data:${preview.mime};base64,${preview.base64}`} alt={label} />
          : <span key={id}>{label}</span>)}</div>
      {pack.next !== null && <button type="button" className="mtg-action" disabled={busy} onClick={() => void show(pack.next!)}>More stickers</button>}
      {pack.installed ? <span role="status">Sticker pack installed.</span> : install && <button type="button" className="mtg-action"
        disabled={busy} onClick={() => void add(pack.id)}>Install sticker pack</button>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => { setPack(undefined); setError(""); }}>Close sticker pack</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function MediaCollection({ chatId, messageId, kind, actions }: {
  chatId: string; messageId: string; kind: MediaCollectionKind; actions: MediaCollectionActions;
}) {
  const [saved, setSaved] = useState<boolean | null>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const sticker = kind === "sticker";

  async function read() {
    setBusy(true);
    setNotice("");
    try { setSaved(await actions.load(chatId, messageId, kind)); }
    catch { setNotice("Could not check the Telegram collection."); }
    finally { setBusy(false); }
  }

  async function change(expected: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const result = await actions.save(chatId, messageId, kind, !expected, expected);
      if (result === "saved") setSaved(!expected);
      else {
        setSaved(undefined);
        setNotice(result === "changed" ? "The Telegram collection changed. Check it again."
          : "Telegram did not confirm the collection change.");
      }
    } catch {
      setSaved(undefined);
      setNotice("Could not verify the collection change.");
    } finally { setBusy(false); }
  }

  return <div>
    {saved === undefined ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void read()}>
      {sticker ? "Sticker favorites" : "Saved GIFs collection"}
    </button> : saved === null ? <span>Collection action unavailable</span>
      : <button type="button" className="mtg-action" disabled={busy} onClick={() => void change(saved)}>
        {sticker ? saved ? "Remove from favorite stickers" : "Add to favorite stickers" : saved ? "Remove from saved GIFs" : "Save GIF"}
      </button>}
    {notice && <p role="alert">{notice}</p>}
  </div>;
}

function VoiceTranscript({ load }: { load: () => Promise<string> }) {
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="mtg-voice-transcript">
    {text === undefined && <button type="button" className="mtg-action" disabled={loading} onClick={() => {
      setLoading(true);
      setFailed(false);
      void load().then(setText).catch(() => setFailed(true)).finally(() => setLoading(false));
    }}>{loading ? "Transcribing on this Mac…" : "Transcribe locally"}</button>}
    {failed && <p role="alert">Could not transcribe this note on this Mac.</p>}
    {text !== undefined && <p>{text || "No speech detected."}</p>}
  </div>;
}

function Poll({ poll, vote, stop }: {
  poll: PollInfo; vote?: (choices: PollChoice[]) => Promise<boolean>; stop?: () => Promise<boolean>;
}) {
  const { question, options, voters, multiple, quiz, canVote } = poll;
  const name = useId();
  const [draft, setDraft] = useState<PollChoice[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [stopState, setStopState] = useState<"confirm" | "closed" | "error">();
  const closed = poll.closed || stopState === "closed";
  const chosen = options.filter((option) => option.chosen);
  const selection = draft ?? chosen;
  const interactive = vote && canVote && !closed;

  async function submit(choices: PollChoice[]) {
    if (!vote || busy || !canVote || closed) return;
    setBusy(true);
    setError(false);
    try {
      if (await vote(choices.map(({ index, id, text }) => ({ index, id, text })))) setDraft(undefined);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function endPoll() {
    if (!stop || closed || busy) return;
    setBusy(true);
    const confirmed = await stop().catch(() => false);
    setStopState(confirmed ? "closed" : "error");
    if (confirmed) setError(false);
    setBusy(false);
  }

  return <fieldset className="mtg-poll" disabled={busy}>
    <legend>{question}</legend>
    <p>{closed ? "Closed poll" : quiz ? "Quiz" : multiple ? "Multiple answers" : "Poll"}</p>
    <ul>{options.map((option) => {
      const { index, text, percentage } = option;
      const checked = selection.some((choice) => choice.index === index && choice.id === option.id && choice.text === text);
      const label = <>{text}{option.chosen && <small> · Your choice</small>}</>;
      return <li key={index}>
        {interactive ? <label><input type={multiple ? "checkbox" : "radio"} name={name} checked={checked}
          onChange={() => setDraft(multiple ? checked ? selection.filter((choice) => choice.index !== index) : [...selection, option] : [option])} /> {label}</label> : <span>{label}</span>}
        {percentage !== undefined && <span>{percentage}%</span>}
      </li>;
    })}</ul>
    {voters !== undefined && <small>{voters} {voters === 1 ? "voter" : "voters"}</small>}
    {interactive && <p>
      <button type="button" disabled={!draft?.length} onClick={() => void submit(selection)}>Vote</button>
      {chosen.length > 0 && <button type="button" onClick={() => void submit([])}>Retract vote</button>}
    </p>}
    {stop && !closed && (stopState === "confirm" ? <div>
      <p>End voting for everyone?</p>
      <button type="button" className="mtg-action" onClick={() => void endPoll()}>Confirm end poll</button>
      <button type="button" className="mtg-action" onClick={() => setStopState(undefined)}>Cancel</button>
    </div> : <button type="button" className="mtg-action" onClick={() => setStopState("confirm")}>End poll</button>)}
    {stopState === "error" && !closed && <p role="alert">Telegram did not confirm that the poll ended.</p>}
    {error && <p role="alert">Could not confirm the vote. Check the poll before trying again.</p>}
  </fieldset>;
}

const unitFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fileUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

function DocumentButton({ document, save }: { document: DocumentInfo; save?: () => Promise<boolean> }) {
  const { name, sizeBytes, approximateSize } = document;
  const order = sizeBytes ? Math.min(fileUnits.length - 1, Math.floor(Math.log2(sizeBytes) / 10)) : 0;
  const size = sizeBytes === undefined ? undefined
    : `${approximateSize ? "≈ " : ""}${unitFormat.format(sizeBytes / 1024 ** order)} ${fileUnits[order]}`;
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  async function download() {
    if (!save || status === "busy") return;
    setStatus("busy");
    try { setStatus(await save() ? "idle" : "error"); }
    catch { setStatus("error"); }
  }

  if (!save) return <p><bdi>{name}</bdi> {size && <span className="mtg-document-size">{size} · </span>}<span>Download unavailable</span></p>;
  return <>
    <button type="button" className="mtg-action mtg-document" disabled={status === "busy"} onClick={() => void download()}>
      {status === "busy" ? "Downloading" : "Download"} <bdi>{name}</bdi>
    </button>
    {size && <span className="mtg-document-size">{size}</span>}
    {status === "error" && <p role="alert">Could not download this document.</p>}
  </>;
}
