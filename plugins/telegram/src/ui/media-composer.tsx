import { useEffect, useRef, useState } from "react";
import { maxVideoNoteBytes, maxVoiceBytes, type GifSendOptions, type MediaDelivery, type MediaSendOptions, type schemas } from "../core/contract.ts";
import type { z } from "zod";
import { StickerPackOrder, type StickerPackSummary } from "./sticker-pack-order.tsx";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { MediaSendControls } from "./media-send-controls.tsx";

type Kind = "sticker" | "gif";
type Format = "ogg" | "webm" | "mp4";
type Choice = z.infer<typeof schemas.mediaChoices.output>[number] & { gifToken?: string };
type Choices = Choice[];
export type ComposerMediaActions = {
  choices: (kind: Kind) => Promise<Choices>;
  searchGifs?: (query: string) => Promise<Choices>;
  sendFoundGif?: (token: string, delivery?: MediaDelivery) => Promise<string>;
  stickerPacks?: () => Promise<StickerPackSummary[]>;
  reorderStickerPacks?: (order: string[], expected: string[]) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
  stickerPackPage?: (packId: string, offset: number) => Promise<{ choices: Choices; next: number | null }>;
  searchStickers?: (query: string) => Promise<Choices>;
  sendChoice: (kind: Kind, fileId: number, searchQuery?: string, packId?: string, delivery?: MediaDelivery, gif?: GifSendOptions) => Promise<string>;
  sendAlbum: (caption: string, photos: string[], delivery?: MediaDelivery, options?: MediaSendOptions) => Promise<string>;
  sendVideoNote?: (base64: string, format: "webm" | "mp4", delivery?: MediaDelivery) => Promise<string>;
  sendVoice: (base64: string, duration: number, format: Format, delivery?: MediaDelivery) => Promise<string>;
};

const formats: readonly { format: Format; mime: string }[] = [
  { format: "ogg", mime: "audio/ogg;codecs=opus" },
  { format: "webm", mime: "audio/webm;codecs=opus" },
  { format: "mp4", mime: "audio/mp4" },
];

const videoFormats: readonly { format: "webm" | "mp4"; mime: string }[] = [
  { format: "webm", mime: "video/webm;codecs=vp8,opus" },
  { format: "mp4", mime: "video/mp4" },
];

async function encodeRecording(blob: Blob, limit: number): Promise<string> {
  if (!blob.size || blob.size > limit) throw new Error("Invalid recording size.");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

export function MediaComposer({ actions, voice, videoNote, otherMedia, photos, onSent }: {
  actions: ComposerMediaActions;
  voice: boolean;
  videoNote?: boolean;
  otherMedia: boolean;
  photos: boolean;
  onSent?: () => void;
}) {
  const [panel, setPanel] = useState<Kind | "voice" | "video" | "album">();
  const [choices, setChoices] = useState<Choices>();
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string>();
  const [packs, setPacks] = useState<StickerPackSummary[]>();
  const [editingPackOrder, setEditingPackOrder] = useState(false);
  const [packId, setPackId] = useState<string>();
  const [moreStickers, setMoreStickers] = useState<number | null>(null);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [loadingPackPage, setLoadingPackPage] = useState(false);
  const [selected, setSelected] = useState<Choices[number]>();
  const nextAlbumPhotoId = useRef(0);
  const [album, setAlbum] = useState<{ id: number; file: File }[]>([]);
  const [albumOptions, setAlbumOptions] = useState<MediaSendOptions>();
  const [gifCaption, setGifCaption] = useState("");
  const [gifOptions, setGifOptions] = useState<MediaSendOptions>();
  const [caption, setCaption] = useState("");
  const [note, setNote] = useState<{ blob: Blob; seconds: number; format: Format }>();
  const [video, setVideo] = useState<{ blob: Blob; format: "webm" | "mp4" }>();
  const [videoUrl, setVideoUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [silent, setSilent] = useState(false);
  const [deliveryTime, setDeliveryTime] = useState("");
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const active = useRef(true);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current++;
      clearTimeout(timer.current);
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== "inactive") recorder.current.stop();
      }
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!video || panel !== "video") { setVideoUrl(undefined); return; }
    const url = URL.createObjectURL(video.blob);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [video, panel]);

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

  async function open(kind: NonNullable<typeof panel>) {
    const generation = ++request.current;
    setPanel(kind);
    setGifCaption("");
    setGifOptions(undefined);
    setSearchQuery("");
    setSubmittedQuery(undefined);
    setPackId(undefined);
    setPacks(undefined);
    setEditingPackOrder(false);
    setMoreStickers(null);
    setLoadingPacks(false);
    setLoadingPackPage(false);
    setStatus("");
    setSelected(undefined);
    setChoices(undefined);
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

  async function openPack(id: string, offset = 0) {
    if (!actions.stickerPackPage || (offset > 0 && loadingPackPage)) return;
    const generation = ++request.current;
    setLoadingPackPage(true);
    setLoadingPacks(false);
    setSubmittedQuery(undefined);
    setPackId(id);
    setStatus("");
    if (!offset) {
      setSelected(undefined);
      setChoices(undefined);
      setMoreStickers(null);
    }
    try {
      const page = await actions.stickerPackPage(id, offset);
      if (request.current !== generation) return;
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

  async function submit(send: (delivery?: MediaDelivery) => Promise<string>) {
    const at = deliveryTime ? Math.floor(new Date(deliveryTime).getTime() / 1000) : undefined;
    if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) {
      setStatus("Choose a send time in the future.");
      return;
    }
    const delivery = silent || at !== undefined ? { ...(silent ? { silent: true } : {}), ...(at === undefined ? {} : { at }) } : undefined;
    setBusy(true);
    setStatus("");
    try {
      const state = await send(delivery);
      if (!active.current) return;
      if (state === "sent") {
        onSent?.();
        setSelected(undefined);
        setAlbum([]);
        setAlbumOptions(undefined);
        setCaption("");
        setGifCaption("");
        setGifOptions(undefined);
        setNote(undefined);
        setVideo(undefined);
        setPanel(undefined);
        setSilent(false);
        setDeliveryTime("");
        setStatus(at === undefined ? "Sent." : "Scheduled.");
      } else setStatus(state === "failed" ? "Could not send this media. Your selection is still here." : "Delivery unconfirmed. Check the chat before retrying.");
    } catch {
      if (active.current) setStatus("Could not send this media.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function record(withVideo = false) {
    setStatus("");
    if (withVideo) setVideo(undefined);
    else setNote(undefined);
    const limit = withVideo ? 60 : 120;
    const encoding = typeof MediaRecorder !== "undefined" && (withVideo ? videoFormats : formats)
      .find(({ mime }) => MediaRecorder.isTypeSupported(mime));
    if (!encoding || !navigator.mediaDevices?.getUserMedia) {
      setStatus(withVideo ? "Camera recording is unavailable in this browser. Choose a video file."
        : "Microphone recording is unavailable in this browser. Choose a voice file.");
      return;
    }
    setBusy(true);
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true,
        ...(withVideo ? { video: { width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } } : {}) });
      if (!active.current) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = input;
      const writer = new MediaRecorder(input, { mimeType: encoding.mime, audioBitsPerSecond: 32_000,
        ...(withVideo ? { videoBitsPerSecond: 650_000 } : {}) });
      recorder.current = writer;
      const chunks: Blob[] = [];
      const started = performance.now();
      writer.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      writer.onstop = () => {
        clearTimeout(timer.current);
        input.getTracks().forEach((track) => track.stop());
        if (!active.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: encoding.mime });
        if (!blob.size) return;
        if (withVideo && encoding.format !== "ogg") {
          if (blob.size <= maxVideoNoteBytes) setVideo({ blob, format: encoding.format });
          else setStatus("Video note exceeds 8 MiB. Record a shorter clip.");
        } else setNote({ blob, seconds: Math.min(limit, Math.max(1, Math.round((performance.now() - started) / 1000))), format: encoding.format });
      };
      writer.start();
      setRecording(true);
      timer.current = setTimeout(() => { if (writer.state === "recording") writer.stop(); }, limit * 1000);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      if (active.current) setStatus(withVideo ? "Could not start camera recording." : "Could not start microphone recording.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function chooseVoice(file?: File) {
    if (!file || !file.size || file.size > maxVoiceBytes) return;
    setBusy(true);
    try {
      const format = file.name.toLowerCase().endsWith(".ogg") ? "ogg" : file.name.toLowerCase().endsWith(".webm") ? "webm" : "mp4";
      const context = new AudioContext();
      try {
        const audio = await context.decodeAudioData(await file.arrayBuffer());
        if (audio.duration > 120) throw new Error("Voice file exceeds 120 seconds.");
        if (active.current) setNote({ blob: file, format, seconds: Math.max(1, Math.round(audio.duration)) });
      } finally {
        await context.close();
      }
    } catch {
      if (active.current) setStatus("Choose a playable voice file up to two minutes.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const switchDisabled = busy || recording;
  return <div className="mtg-composer-media">
    <div className="mtg-composer-media-buttons">
      {videoNote && actions.sendVideoNote && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => void open("video")}>Video note</button>}
      {voice && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => void open("voice")}>Voice</button>}
      {otherMedia && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => void open("sticker")}>Stickers</button>}
      {otherMedia && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => void open("gif")}>GIFs</button>}
      {photos && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => void open("album")}>Photo album</button>}
      {panel && <button type="button" className="mtg-action" disabled={switchDisabled} onClick={() => { request.current++; setPanel(undefined); setStatus(""); }}>Close media</button>}
    </div>
    {panel && <details>
      <summary>Media delivery options</summary>
      <label><input type="checkbox" checked={silent} disabled={switchDisabled}
        onChange={(event) => setSilent(event.currentTarget.checked)} /> Send without sound</label>
      <label>Schedule media <input type="datetime-local" value={deliveryTime} disabled={switchDisabled}
        onInput={(event) => { setDeliveryTime(event.currentTarget.value); setStatus(""); }} /></label>
    </details>}
    {(panel === "sticker" || panel === "gif") && <>
      {search && <div className="mtg-media-choices">
        <input type="search" aria-label={panel === "sticker" ? "Search stickers" : "Search GIFs"}
          placeholder={panel === "sticker" ? "Search stickers" : "Search GIFs"} value={searchQuery} maxLength={80}
          disabled={busy} onChange={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            void findMedia();
          }} />
        <button type="button" className="mtg-action" disabled={busy || !searchQuery.trim()} onClick={() => void findMedia()}>{panel === "sticker" ? "Find stickers" : "Find GIFs"}</button>
        {submittedQuery && <button type="button" className="mtg-action" disabled={busy} onClick={() => void open(panel)}>{panel === "sticker" ? "Recent and favorites" : "Saved GIFs"}</button>}
      </div>}
      {panel === "sticker" && actions.stickerPacks && actions.stickerPackPage && <div className="mtg-media-choices">
        {packs === undefined ? <button type="button" className="mtg-action" disabled={busy || loadingPacks}
          onClick={() => void browsePacks()}>{loadingPacks ? "Loading sticker packs…" : "Installed sticker packs"}</button>
          : packs.length === 0 ? <p>No installed sticker packs.</p>
          : <label>Sticker pack <select value={packId ?? ""} disabled={busy} onChange={(event) => {
            const id = event.currentTarget.value;
            if (id) void openPack(id);
            else void open("sticker");
          }}>
            <option value="">Recent and favorites</option>
            {packs.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select></label>}
        {packs && packs.length > 1 && actions.reorderStickerPacks && (editingPackOrder
          ? <StickerPackOrder packs={packs} save={actions.reorderStickerPacks}
            onSaved={(current, next) => setPacks((previous) => previous === current ? next : previous)}
            reload={() => { setEditingPackOrder(false); void browsePacks(); }}
            close={() => setEditingPackOrder(false)} />
          : <button type="button" className="mtg-action" disabled={busy} onClick={() => setEditingPackOrder(true)}>Reorder sticker packs</button>)}
      </div>}
      <div className="mtg-media-choices" aria-label={panel === "sticker"
        ? submittedQuery ? "Sticker search results" : packId ? "Stickers in pack" : "Recent and favorite stickers" : submittedQuery ? "GIF search results" : "Saved GIFs"}>
        {!choices && <p role="status">Loading…</p>}
        {choices?.length === 0 && !status && <p>{panel === "sticker" ? submittedQuery ? "No matching stickers." : packId ? "No stickers in this pack." : "No recent or favorite stickers." : submittedQuery ? "No matching GIFs." : "No saved GIFs."}</p>}
        {choices?.map((choice) => <button key={choice.id} type="button" className="mtg-action" aria-pressed={selected?.id === choice.id}
          disabled={busy} onClick={() => setSelected(choice)}>
          {choice.preview && <img src={`data:${choice.preview.mime};base64,${choice.preview.base64}`} alt="" />}{choice.label}
        </button>)}
      </div>
      {packId && moreStickers !== null && <button type="button" className="mtg-action" disabled={busy || loadingPackPage}
        onClick={() => void openPack(packId, moreStickers)}>{loadingPackPage ? "Loading stickers…" : "More stickers"}</button>}
      {panel === "gif" && selected && !selected.gifToken && <div>
        <label>GIF caption <input value={gifCaption} maxLength={1024} disabled={busy}
          onChange={(event) => setGifCaption(event.currentTarget.value)} /></label>
        <MediaSendControls kind="GIF" options={gifOptions} hasCaption={!!gifCaption.trim()} disabled={busy} change={setGifOptions} />
      </div>}
      {selected && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void submit((delivery) => {
          if (selected.gifToken && actions.sendFoundGif) {
            return delivery ? actions.sendFoundGif(selected.gifToken, delivery) : actions.sendFoundGif(selected.gifToken);
          }
          if (panel === "gif" && !selected.gifToken && (gifCaption.trim() || gifOptions?.spoiler)) {
            return actions.sendChoice(panel, selected.id, undefined, undefined, delivery,
              { ...gifOptions, caption: gifCaption.trim() });
          }
          const query = panel === "sticker" ? submittedQuery : undefined;
          if (delivery) return actions.sendChoice(panel, selected.id, query, packId, delivery);
          if (packId) return actions.sendChoice(panel, selected.id, undefined, packId);
          return query ? actions.sendChoice(panel, selected.id, query) : actions.sendChoice(panel, selected.id);
        })}>{deliveryTime ? "Schedule" : "Send"} {panel === "gif" ? "GIF" : "sticker"}</button>}
    </>}
    {panel === "album" && <>
      <label>{album.length ? "Add album photos" : "Choose album photos"}
        <input type="file" multiple accept={photoAccept} disabled={busy || album.length >= 10}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (!files.length) return;
            if (album.length + files.length > 10) {
              setStatus("An album can contain up to 10 photos.");
              return;
            }
            if (!files.every((file) => isPhotoMimeType(file.type) && file.size > 0 && file.size <= maxOriginalPhotoBytes)) {
              setStatus("Choose non-empty JPEG, PNG or WebP photos up to 64 MiB each.");
              return;
            }
            const additions = files.map((file) => ({ id: nextAlbumPhotoId.current++, file }));
            setAlbum((previous) => [...previous, ...additions]);
            setStatus("");
          }} />
      </label>
      {album.length > 0 && <div>
        <ol className="mtg-album-order" aria-label="Album photo order">
          {album.map(({ id, file }, index) => <li key={id}>
            <AlbumPhotoPreview file={file} />
            <bdi>{file.name}</bdi>
            <button type="button" className="mtg-action" aria-label={`Move photo ${index + 1} up`}
              disabled={busy || index === 0} onClick={() => moveAlbumPhoto(index, -1)}>↑</button>
            <button type="button" className="mtg-action" aria-label={`Move photo ${index + 1} down`}
              disabled={busy || index === album.length - 1} onClick={() => moveAlbumPhoto(index, 1)}>↓</button>
            <button type="button" className="mtg-action" aria-label={`Remove photo ${index + 1}`} disabled={busy}
              onClick={() => {
                setAlbum((previous) => previous.filter((photo) => photo.id !== id));
                setStatus("");
              }}>×</button>
          </li>)}
        </ol>
        <label>Album caption <input value={caption} maxLength={1024} disabled={busy}
          onChange={(event) => setCaption(event.target.value)} /></label>
        <MediaSendControls kind="photos" options={albumOptions} hasCaption={!!caption.trim()} disabled={busy} change={setAlbumOptions} />
      </div>}
      <button type="button" className="mtg-action" disabled={busy || album.length < 2} onClick={() =>
        void submit(async (delivery) => {
          const photos: string[] = [];
          for (const { file } of album) photos.push(await preparePhoto(file));
          if (albumOptions?.spoiler || (caption.trim() && albumOptions?.captionAbove)) {
            return actions.sendAlbum(caption, photos, delivery, albumOptions);
          }
          return delivery ? actions.sendAlbum(caption, photos, delivery) : actions.sendAlbum(caption, photos);
        })}>{deliveryTime ? "Schedule album" : "Send album"}</button>
    </>}
    {panel === "voice" && <>
      {recording ? <button type="button" className="mtg-action" onClick={() => recorder.current?.stop()}>Stop recording</button>
        : <button type="button" className="mtg-action" disabled={busy} onClick={() => void record()}>Record voice</button>}
      {!recording && <input type="file" accept=".ogg,.webm,.m4a,.mp4" aria-label="Choose voice file" disabled={busy}
        onChange={(event) => void chooseVoice(event.target.files?.[0])} />}
      {note && <><span>{note.seconds}s</span> <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void submit(async (delivery) => {
          const base64 = await encodeRecording(note.blob, maxVoiceBytes);
          return delivery ? actions.sendVoice(base64, note.seconds, note.format, delivery) : actions.sendVoice(base64, note.seconds, note.format);
        })}>{deliveryTime ? "Schedule voice note" : "Send voice note"}</button></>}
    </>}
    {panel === "video" && <>
      {recording ? <button type="button" className="mtg-action" onClick={() => recorder.current?.stop()}>Stop video recording</button>
        : <button type="button" className="mtg-action" disabled={busy} onClick={() => void record(true)}>Record video note</button>}
      {!recording && <input type="file" accept=".webm,.mp4,video/webm,video/mp4" aria-label="Choose video note file" disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          event.currentTarget.value = "";
          if (!/\.(webm|mp4)$/i.test(file.name) || !file.size || file.size > maxVideoNoteBytes) {
            setVideo(undefined);
            setStatus("Choose a WebM or MP4 video up to 8 MiB.");
            return;
          }
          setStatus("");
          setVideo({ blob: file, format: /\.webm$/i.test(file.name) ? "webm" : "mp4" });
        }} />}
      {videoUrl && <video className="mtg-video-note-preview" src={videoUrl} aria-label="Video note preview" controls playsInline
        onLoadedMetadata={(event) => {
          if (event.currentTarget.duration > 60.5) setStatus("Telegram will receive the first 60 seconds.");
        }} onError={() => { setVideo(undefined); setStatus("Could not read this video file."); }} />}
      {video && actions.sendVideoNote && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void submit(async (delivery) => actions.sendVideoNote!(await encodeRecording(video.blob, maxVideoNoteBytes), video.format, delivery))}>
        {deliveryTime ? "Schedule video note" : "Send video note"}
      </button>}
    </>}
    {status && <p role="status">{status}</p>}
  </div>;
}

function AlbumPhotoPreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return preview?.file === file
    ? <img className="mtg-attachment-preview" src={preview.url} alt="" loading="lazy" />
    : null;
}
