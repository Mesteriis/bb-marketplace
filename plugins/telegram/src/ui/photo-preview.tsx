import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoSize, TelegramPhoto } from "../core/contract.ts";

export type AlbumPhoto = { id: string; spoiler?: boolean; canSave?: boolean };

export function PhotoPreview({ chatId, messageId, load, spoiler, dimensions, album, canSave, save }: {
  chatId: string;
  messageId: string;
  spoiler?: boolean;
  album?: readonly AlbumPhoto[];
  canSave?: boolean;
  save?: (chatId: string, messageId: string) => Promise<boolean>;
  dimensions?: { width: number; height: number };
  load: (chatId: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [photo, setPhoto] = useState<TelegramPhoto>();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [expanded, setExpanded] = useState(false);
  const [large, setLarge] = useState<TelegramPhoto>();
  const [loadingLarge, setLoadingLarge] = useState(false);
  const [largeUnavailable, setLargeUnavailable] = useState(false);
  const [selectedPhoto, setSelected] = useState(messageId);
  const [revealedAlbum, setRevealedAlbum] = useState<ReadonlySet<string>>(() => new Set());
  const [albumImage, setAlbumImage] = useState<{ id: string; photo?: TelegramPhoto; failed?: true }>();
  const selected = album?.some(({ id }) => id === selectedPhoto) ? selectedPhoto : messageId;
  const albumIndex = album?.findIndex(({ id }) => id === selected) ?? -1;
  const albumSpoiler = selected !== messageId && album?.[albumIndex]?.spoiler && !revealedAlbum.has(selected);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string>();
  const viewer = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const placeholder = useRef<HTMLDivElement>(null);
  const canObserve = typeof IntersectionObserver === "function";
  const frame = dimensions ? {
    width: Math.min(dimensions.width, 280 * dimensions.width / dimensions.height),
    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
  } : undefined;

  const open = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setStatus("loading");
    try {
      setPhoto(await load(chatId, messageId));
      setStatus("idle");
    } catch {
      setStatus("error");
    } finally {
      pending.current = false;
    }
  }, [chatId, messageId, load]);

  useEffect(() => {
    const target = placeholder.current;
    if (!target || !canObserve || status !== "idle" || photo) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) return;
      observer.disconnect();
      void open();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canObserve, open, photo, status]);

  useEffect(() => {
    if (!expanded || selected === messageId || albumIndex < 0 || albumSpoiler) return;
    let active = true;
    void load(chatId, selected).then(async (photo) => {
      if (!active) return;
      setAlbumImage({ id: selected, photo });
      if (photo.hasLarger) {
        const larger = await load(chatId, selected, "large").catch(() => undefined);
        if (active && larger) setAlbumImage({ id: selected, photo: larger });
      }
    }, () => { if (active) setAlbumImage({ id: selected, failed: true }); });
    return () => { active = false; };
  }, [expanded, chatId, selected, messageId, albumIndex, albumSpoiler, load]);

  function movePhoto(offset: -1 | 1) {
    const next = albumIndex >= 0 ? album?.[albumIndex + offset] : undefined;
    if (!next) return;
    setAlbumImage(undefined);
    setSelected(next.id);
  }

  async function savePhoto() {
    if (!save || saving) return;
    setSaving(true);
    setSaveFailed(undefined);
    try {
      if (!await save(chatId, selected)) setSaveFailed(selected);
    } catch {
      setSaveFailed(selected);
    } finally {
      setSaving(false);
    }
  }

  if (spoiler && !revealed) return <div className="mtg-photo-state">
    <button className="mtg-action" type="button" onClick={() => {
      setRevealed(true);
      void open();
    }}>Show photo spoiler</button>
  </div>;

  if (photo) {
    const enlargedSource = large ? `data:${large.mime};base64,${large.base64}` : undefined;
    const source = `data:${photo.mime};base64,${photo.base64}`;
    return <>
      <button type="button" className="mtg-photo-open" style={frame} aria-label="Enlarge Telegram photo" onClick={() => {
        viewer.current?.showModal();
        setSaveFailed(undefined);
        setSelected(messageId);
        setAlbumImage(undefined);
        setRevealedAlbum(new Set());
        setExpanded(true);
        if (photo.hasLarger && !large && !loadingLarge) {
          setLoadingLarge(true);
          setLargeUnavailable(false);
          void load(chatId, messageId, "large").then(setLarge, () => setLargeUnavailable(true))
            .finally(() => setLoadingLarge(false));
        }
      }}>
        <img className="mtg-photo" src={source} alt="Telegram photo" width={dimensions?.width} height={dimensions?.height}
          onError={() => { setPhoto(undefined); setStatus("error"); }} />
      </button>
      <dialog className="mtg-photo-viewer" ref={viewer} aria-label="Telegram photo viewer"
        onClose={() => setExpanded(false)}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.classList.contains("mtg-photo-zoom-viewport")) return;
          if (albumIndex < 0 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          movePhoto(event.key === "ArrowLeft" ? -1 : 1);
        }}>
        <button type="button" className="mtg-action" onClick={() => viewer.current?.close()}>Close photo</button>
        {expanded && save && (selected === messageId ? canSave : album?.[albumIndex]?.canSave && !albumSpoiler && albumImage?.id === selected && albumImage.photo)
          && <button type="button" className="mtg-action" disabled={saving} onClick={() => void savePhoto()}>
            {saving ? "Saving photo…" : "Save photo"}
          </button>}
        {expanded && saveFailed === selected && <span role="alert">Could not save this photo.</span>}
        {expanded && album && album.length > 1 && albumIndex >= 0 && <div className="mtg-photo-navigation">
          <button type="button" className="mtg-action" aria-label="Previous photo" disabled={albumIndex === 0}
            onClick={() => movePhoto(-1)}>←</button>
          <span role="status">{albumIndex + 1} / {album.length}</span>
          <button type="button" className="mtg-action" aria-label="Next photo" disabled={albumIndex === album.length - 1}
            onClick={() => movePhoto(1)}>→</button>
        </div>}
        {expanded && selected !== messageId && (albumSpoiler
          ? <button type="button" className="mtg-action" onClick={() => setRevealedAlbum((previous) => new Set([...previous, selected]))}>Show photo spoiler</button>
          : albumImage?.id !== selected ? <span role="status">Loading photo…</span>
          : albumImage.failed ? <span role="alert">Photo unavailable.</span>
          : albumImage.photo && <ZoomablePhoto key={selected} source={`data:${albumImage.photo.mime};base64,${albumImage.photo.base64}`} />)}
        {expanded && selected === messageId && loadingLarge && <span role="status">Loading larger photo…</span>}
        {expanded && selected === messageId && largeUnavailable && <span role="status">Larger photo unavailable. Showing preview.</span>}
        {expanded && selected === messageId && <ZoomablePhoto key={messageId} source={enlargedSource ?? source} onError={() => {
          if (large) {
            setLarge(undefined);
            setLargeUnavailable(true);
          }
        }} />}
      </dialog>
    </>;
  }
  if (canObserve && status !== "error") return <div ref={placeholder} className="mtg-photo-placeholder" style={frame}
    aria-label={status === "loading" ? "Loading photo" : undefined} />;
  return <div className="mtg-photo-state">
    <button className="mtg-action" type="button" disabled={status === "loading"} onClick={() => void open()}>
      {status === "loading" ? "Loading photo…" : status === "error" ? "Retry photo" : "Show photo"}
    </button>
    {status === "error" && <span role="alert">Photo unavailable.</span>}
  </div>;
}

function ZoomablePhoto({ source, onError }: { source: string; onError?: () => void }) {
  const [zoom, setZoom] = useState(1);
  return <>
    <div className="mtg-photo-navigation" role="group" aria-label="Photo zoom">
      <button type="button" className="mtg-action" aria-label="Zoom out" disabled={zoom <= 1}
        onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>−</button>
      <button type="button" className="mtg-action" aria-label="Reset photo zoom" disabled={zoom === 1}
        onClick={() => setZoom(1)}>{zoom === 1 ? "Fit" : `${zoom * 100}%`}</button>
      <button type="button" className="mtg-action" aria-label="Zoom in" disabled={zoom >= 4}
        onClick={() => setZoom((value) => Math.min(4, value + 0.5))}>+</button>
    </div>
    <div className="mtg-photo-zoom-viewport" tabIndex={zoom > 1 ? 0 : undefined} aria-label={zoom > 1 ? "Zoomed photo" : undefined}>
      <img src={source} alt="Enlarged Telegram photo" style={{ zoom }} onError={onError} />
    </div>
  </>;
}
