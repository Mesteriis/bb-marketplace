import { useTelegramLocale } from "./i18n/index.tsx";
import { ChevronLeft, ChevronRight, Download, Maximize, MessageSquare, Minus, PencilLine, Plus } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MediaViewerFrame, MediaViewerLoading } from "./media-viewer-frame.tsx";
import { PhotoText, PhotoTextRecognition } from "./photo-text.tsx";
import { PhotoFileDrag } from "./photo-file-drag.tsx";
import type { Message } from "../core/demo.ts";
import type { PhotoMotion, PhotoSize, PhotoTextResult, RichStyledRange, TelegramPhoto } from "../core/contract.ts";
import { MessageText } from "./message-text.tsx";
import { isSaveShortcut } from "./composer-keys.ts";
import { PhotoEditor } from "./edit-draft-photo.tsx";
import { preparedPhotoBlob } from "./prepare-photo.ts";

type PhotoCaption = Pick<Message, "photoCaption" | "links" | "customEmoji"> & { styles?: readonly RichStyledRange[] };

export type AlbumPhoto = { id: string; spoiler?: boolean; canSave?: boolean; caption?: PhotoCaption; motion?: PhotoMotion };
export type DrawPhotoReply = { verify: (id: string) => Promise<boolean>; stage: (id: string, jpeg: string) => Promise<boolean> };
export type DrawPhotoReplyFromMessage = { verify: (message: Message) => Promise<boolean>; stage: (message: Message, jpeg: string) => Promise<boolean> };

export function photoTimeline(messages: readonly Message[]): AlbumPhoto[] | undefined {
  const photos = messages.filter((message) => message.hasPhoto && !message.oneView && !message.retained
    && !message.pendingDelivery && !message.collectionKind && !message.tgsSticker)
    .map(({ id, photoSpoiler, canSavePhoto, photoCaption, links, styles, customEmoji, photoMotion, failedDelivery }) => ({
      id, spoiler: photoSpoiler, canSave: canSavePhoto, motion: failedDelivery ? undefined : photoMotion,
      caption: photoCaption ? { photoCaption, links, styles, customEmoji } : undefined,
    }));
  return photos.length > 1 ? photos : undefined;
}

export type MorePhotos = { pending: boolean; failed: boolean; load: () => void };

export function PhotoPreview({ chatId, messageId, load, spoiler, dimensions, articleLayout, album, morePhotos, canSave, save, drawReply, openMessage, caption, renderPhotoLink, motion, renderAlbumMotion, inConversation }: {
  chatId: string;
  messageId: string;
  spoiler?: boolean;
  album?: readonly AlbumPhoto[];
  morePhotos?: MorePhotos;
  caption?: PhotoCaption;
  openMessage?: (id: string) => void;
  renderPhotoLink?: (image?: ReactNode) => ReactNode;
  motion?: ReactNode;
  renderAlbumMotion?: (id: string, motion: PhotoMotion) => ReactNode;
  canSave?: boolean;
  drawReply?: DrawPhotoReply;
  save?: (chatId: string, messageId: string) => Promise<boolean>;
  dimensions?: { width: number; height: number };
  inConversation?: boolean;
  articleLayout?: { width: number; scale: number };
  load: (chatId: string, messageId: string, size?: PhotoSize) => Promise<TelegramPhoto>;
}) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  const recognize = useContext(PhotoTextRecognition);
  const [photo, setPhoto] = useState<TelegramPhoto>();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [expanded, setExpanded] = useState(false);
  const [large, setLarge] = useState<TelegramPhoto>();
  const [loadingLarge, setLoadingLarge] = useState(false);
  const [largeUnavailable, setLargeUnavailable] = useState(false);
  const [selectedPhoto, setSelected] = useState(messageId);
  const [revealedAlbum, setRevealedAlbum] = useState<ReadonlySet<string>>(() => new Set());
  const [albumImage, setAlbumImage] = useState<{ id: string; photo?: TelegramPhoto; larger?: TelegramPhoto; failed?: true }>();
  const [photoAttempt, setPhotoAttempt] = useState(0);
  const selected = album?.some(({ id }) => id === selectedPhoto) ? selectedPhoto : messageId;
  const albumIndex = album?.findIndex(({ id }) => id === selected) ?? -1;
  const selectedCaption = selected === messageId ? caption ?? album?.[albumIndex]?.caption : album?.[albumIndex]?.caption;
  const selectedMotion = album?.[albumIndex]?.motion;
  const albumSpoiler = selected !== messageId && album?.[albumIndex]?.spoiler && !revealedAlbum.has(selected);
  const canSaveSelected = selected === messageId ? !!(canSave && photo && (!spoiler || revealed))
    : !!(album?.[albumIndex]?.canSave && !albumSpoiler && albumImage?.id === selected && albumImage.photo);
  const textRecognition = recognize && canSaveSelected && /^-?[1-9]\d{0,15}$/.test(chatId) && /^[1-9]\d{0,15}$/.test(selected)
    ? async (visible: TelegramPhoto, size: PhotoSize) => {
      const bytes = Uint8Array.from(atob(visible.base64), (byte) => byte.charCodeAt(0));
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return recognize(chatId, selected, size, sha256);
    } : undefined;
  const savingInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string>();
  const [drawing, setDrawing] = useState<{ id: string; source: Blob }>();
  const [checkingDraw, setCheckingDraw] = useState(false);
  const [drawFailed, setDrawFailed] = useState(false);
  const drawAttempt = useRef(0);
  const viewer = useRef<HTMLDialogElement>(null);
  const closeViewer = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const restoreOpener = useRef(false);
  const [recognitionPanel, setRecognitionPanel] = useState<HTMLDivElement | null>(null);
  const previousPhoto = useRef<HTMLButtonElement>(null);
  const nextPhoto = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const pendingLarge = useRef(false);
  const placeholder = useRef<HTMLDivElement>(null);
  const inlineImage = useRef<HTMLImageElement>(null);
  const canObserve = typeof IntersectionObserver === "function";
  const frame = !inConversation && dimensions ? {
    width: articleLayout?.width ?? Math.min(dimensions.width, 280 * dimensions.width / dimensions.height),
    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
  } : undefined;

  function resetViewer() {
    drawAttempt.current++;
    setCheckingDraw(false);
    setDrawFailed(false);
    setExpanded(false);
  }

  function closePhoto(restoreFocus = true) {
    restoreOpener.current = restoreFocus;
    if (viewer.current?.open) viewer.current.close();
    resetViewer();
  }

  useLayoutEffect(() => {
    if (expanded && viewer.current && !viewer.current.open) {
      viewer.current.showModal();
      closeViewer.current?.focus({ preventScroll: true });
    } else if (!expanded && restoreOpener.current) {
      restoreOpener.current = false;
      opener.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

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

  const loadLarge = useCallback(() => {
    if (!photo?.hasLarger || large || pendingLarge.current) return;
    pendingLarge.current = true;
    setLoadingLarge(true);
    setLargeUnavailable(false);
    void load(chatId, messageId, "large").then(setLarge, () => setLargeUnavailable(true)).finally(() => {
      pendingLarge.current = false;
      setLoadingLarge(false);
    });
  }, [chatId, messageId, load, photo, large]);

  const articleScale = articleLayout?.scale;
  const previewWidth = dimensions?.width;
  useEffect(() => {
    const target = inlineImage.current;
    if (!target || articleScale === undefined || !previewWidth || !photo?.hasLarger || large || loadingLarge
      || largeUnavailable || !canObserve) return;
    let visible = false;
    const upgrade = () => {
      const width = target.getBoundingClientRect().width * (window.devicePixelRatio || 1);
      if (visible && width > previewWidth) loadLarge();
    };
    const intersection = new IntersectionObserver((entries) => {
      visible = entries.at(-1)?.isIntersecting === true;
      upgrade();
    });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(upgrade) : undefined;
    intersection.observe(target);
    resize?.observe(target);
    return () => { visible = false; intersection.disconnect(); resize?.disconnect(); };
  }, [articleScale, canObserve, large, largeUnavailable, loadLarge, loadingLarge, photo, previewWidth]);

  useEffect(() => {
    if (!expanded || selected === messageId || albumIndex < 0 || albumSpoiler) return;
    let active = true;
    void load(chatId, selected).then(async (photo) => {
      if (!active) return;
      setAlbumImage({ id: selected, photo });
      if (photo.hasLarger) {
        const larger = await load(chatId, selected, "large").catch(() => undefined);
        if (active && larger) setAlbumImage((current) => current?.id === selected && current.photo === photo
          ? { ...current, larger } : current);
      }
    }, () => { if (active) setAlbumImage({ id: selected, failed: true }); });
    return () => { active = false; };
  }, [expanded, chatId, selected, messageId, albumIndex, albumSpoiler, load, photoAttempt]);

  function movePhoto(offset: -1 | 1) {
    if (!album || albumIndex < 0) return;
    const index = albumIndex + offset;
    const next = album[index];
    if (!next) return;
    drawAttempt.current++;
    setCheckingDraw(false);
    setDrawFailed(false);
    const focused = document.activeElement;
    if ((index === 0 && focused === previousPhoto.current)
      || (index === album.length - 1 && focused === nextPhoto.current)
      || (focused instanceof Element && focused.closest(".mtg-photo-caption, .mtg-photo-zoom-viewport, .mtg-media-player"))) {
      closeViewer.current?.focus({ preventScroll: true });
    }
    setAlbumImage(undefined);
    setSelected(next.id);
  }

  async function savePhoto() {
    if (!save || !viewer.current?.open || !expanded || !canSaveSelected || savingInFlight.current) return;
    savingInFlight.current = true;
    setSaving(true);
    setSaveFailed(undefined);
    const id = selected;
    try {
      if (!await save(chatId, id)) setSaveFailed(id);
    } catch {
      setSaveFailed(id);
    } finally {
      savingInFlight.current = false;
      setSaving(false);
    }
  }

  async function startDrawing() {
    const image = selected === messageId ? large ?? photo
      : albumImage?.id === selected ? albumImage.larger ?? albumImage.photo : undefined;
    if (!image || !drawReply || !canSaveSelected || checkingDraw || !viewer.current?.open) return;
    const attempt = ++drawAttempt.current;
    setCheckingDraw(true);
    setDrawFailed(false);
    try {
      const allowed = await drawReply.verify(selected);
      if (attempt !== drawAttempt.current || !viewer.current?.open) return;
      if (allowed) setDrawing({ id: selected, source: preparedPhotoBlob(image.base64, image.mime) });
      else setDrawFailed(true);
    } catch {
      if (attempt === drawAttempt.current && viewer.current?.open) setDrawFailed(true);
    } finally {
      if (attempt === drawAttempt.current) setCheckingDraw(false);
    }
  }

  if (spoiler && !revealed) return <div className="mtg-photo-state">
    <button className="mtg-action" type="button" data-photo-opener={openMessage ? messageId : undefined} onClick={() => {
      setRevealed(true);
      void open();
    }}>{tr("Show photo spoiler")}</button>
  </div>;

  if (photo) {
    const enlargedSource = large ? photoSource(large) : undefined;
    const source = articleLayout && enlargedSource ? enlargedSource : photoSource(photo);
    function enlarge() {
      setSaveFailed(undefined);
      setSelected(messageId);
      setAlbumImage(undefined);
      setRevealedAlbum(new Set());
      setExpanded(true);
      loadLarge();
    }
    const image = <img ref={inlineImage} className="mtg-photo" src={source} alt={renderPhotoLink ? tr("Open photo link") : tr("Telegram photo")} draggable={false}
      width={dimensions?.width} height={dimensions?.height} onError={() => {
        if (articleLayout && large) { setLarge(undefined); setLargeUnavailable(true); }
        else { setPhoto(undefined); setStatus("error"); }
      }} />;
    const hasCaption = !albumSpoiler && !!selectedCaption?.photoCaption;
    const canJump = openMessage !== undefined;
    const canDrag = save && canSaveSelected && /^-?[1-9]\d{0,15}$/.test(chatId) && /^[1-9]\d{0,15}$/.test(selected);
    const canDraw = drawReply && canSaveSelected;
    const showMore = morePhotos && (morePhotos.pending || morePhotos.failed || !album || albumIndex === album.length - 1);
    const details = (hasCaption || canJump || canDrag || canDraw || textRecognition) && <>
      {hasCaption && <section className="mtg-photo-caption">
        <h2>{tr("Photo caption")}</h2>
        <MessageText key={selected} text={selectedCaption.photoCaption} links={selectedCaption.links}
          styles={selectedCaption.styles} customEmoji={selectedCaption.customEmoji} />
      </section>}
      <div className="mtg-viewer-detail-actions">
        {canJump && <button type="button" className="mtg-viewer-detail-action" onClick={() => {
          closePhoto(false);
          openMessage(selected);
        }}><MessageSquare size={16} aria-hidden="true" />{tr("Go to photo message")}</button>}
        <div ref={setRecognitionPanel} />
        {canDrag && <PhotoFileDrag key={selected} chatId={chatId} messageId={selected} save={savePhoto} />}
        {canDraw && <button type="button" className="mtg-viewer-detail-action" disabled={checkingDraw}
          onClick={() => void startDrawing()}><PencilLine size={16} aria-hidden="true" />{tr("Draw to reply")}</button>}
        {drawFailed && <span role="alert">{tr("This photo is unavailable for a drawn reply.")}</span>}
      </div>
    </>;
    const photoViewer = <dialog className="mtg-photo-viewer mtg-media-viewer" ref={viewer} aria-label={tr("Telegram photo viewer")}
        onCancel={(event) => { event.preventDefault(); closePhoto(); }}
        onClose={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (expanded && event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest("dialog") !== event.currentTarget)) {
            event.preventDefault(); event.stopPropagation(); closePhoto(); return;
          }
          if (expanded && event.currentTarget.open && isSaveShortcut(event)) {
            event.preventDefault();
            if (!event.repeat) void savePhoto();
            return;
          }
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
            || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
            || (event.target instanceof HTMLElement && event.target.closest(".mtg-photo-zoom-viewport, .mtg-media-player, .mtg-viewer-details"))) return;
          if (!expanded || !album || album.length < 2 || albumIndex < 0
            || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          movePhoto(event.key === "ArrowLeft" ? -1 : 1);
        }}>
        {expanded && <MediaViewerFrame closeRef={closeViewer} close={() => closePhoto()} closeLabel={tr("Close photo")}
          counter={album && albumIndex >= 0 ? `${albumIndex + 1} / ${album.length}` : undefined} details={details}
          previous={albumIndex > 0 ? () => movePhoto(-1) : undefined}
          next={album && albumIndex >= 0 && albumIndex < album.length - 1 ? () => movePhoto(1) : undefined}
          actions={save && canSaveSelected && <button type="button" className="mtg-photo-icon-button" aria-keyshortcuts="Meta+S Control+S"
            aria-label={saving ? tr("Saving photo…") : tr("Save photo")} title={tr("Save photo")} disabled={saving} onClick={() => void savePhoto()}>
            <Download size={18} aria-hidden="true" />
          </button>}>
        {saveFailed === selected && <span className="mtg-viewer-notice" role="alert">{tr("Could not save this photo.")}</span>}
        {album && album.length > 1 && albumIndex >= 0 && <>
          <button ref={previousPhoto} type="button" className="mtg-viewer-arrow" data-direction="previous"
            aria-label={tr("Previous photo")} title={tr("Previous photo")} disabled={albumIndex === 0}
            onClick={() => movePhoto(-1)}><ChevronLeft size={20} aria-hidden="true" /></button>
          <button ref={nextPhoto} type="button" className="mtg-viewer-arrow" data-direction="next"
            aria-label={tr("Next photo")} title={tr("Next photo")} disabled={albumIndex === album.length - 1}
            onClick={() => movePhoto(1)}><ChevronRight size={20} aria-hidden="true" /></button>
        </>}
        {showMore && <div className="mtg-viewer-more-photos">
          <button type="button" className="mtg-action" disabled={morePhotos.pending} onClick={() => {
            closeViewer.current?.focus({ preventScroll: true });
            morePhotos.load();
          }}>{morePhotos.failed ? tr("Retry loading more photos") : tr("Load more photos")}</button>
          {morePhotos.pending && <span role="status">{tr("Loading more photos…")}</span>}
          {morePhotos.failed && <span role="alert">{tr("Could not load more photos.")}</span>}
        </div>}
        <div className="mtg-viewer-photo-content">
        {expanded && (selected === messageId ? motion
          : !albumSpoiler && albumImage?.id === selected && albumImage.photo && selectedMotion && renderAlbumMotion?.(selected, selectedMotion))}
        {expanded && selected !== messageId && (albumSpoiler
          ? <button type="button" className="mtg-action" onClick={() => {
            closeViewer.current?.focus({ preventScroll: true });
            setRevealedAlbum((previous) => new Set([...previous, selected]));
          }}>{tr("Show photo spoiler")}</button>
          : albumImage?.id !== selected ? <MediaViewerLoading label={tr("Loading photo…")} />
          : albumImage.failed ? <div className="mtg-photo-state">
            <span role="alert">{tr("Photo unavailable.")}</span>
            <button type="button" className="mtg-action" onClick={() => {
              closeViewer.current?.focus({ preventScroll: true });
              setAlbumImage(undefined);
              setPhotoAttempt((attempt) => attempt + 1);
            }}>{tr("Retry photo")}</button>
          </div>
          : albumImage.photo && <ZoomablePhoto key={selected} recognitionPanel={recognitionPanel} source={photoSource(albumImage.larger ?? albumImage.photo)} move={movePhoto}
            recognitionSize={albumImage.larger ? "large" : "preview"}
            recognize={textRecognition && (() => textRecognition(albumImage.larger ?? albumImage.photo!, albumImage.larger ? "large" : "preview"))} onError={() => {
            setAlbumImage((current) => current !== albumImage ? current : current.larger
              ? { ...current, larger: undefined } : { id: selected, failed: true });
          }} />)}
        {expanded && selected === messageId && loadingLarge && <MediaViewerLoading compact label={tr("Loading larger photo…")} />}
        {expanded && selected === messageId && largeUnavailable && <span role="status">{tr("Larger photo unavailable. Showing preview.")}</span>}
        {expanded && selected === messageId && <ZoomablePhoto key={messageId} recognitionPanel={recognitionPanel} source={enlargedSource ?? source} move={movePhoto}
          recognitionSize={large ? "large" : "preview"}
          recognize={textRecognition && (() => textRecognition(large ?? photo, large ? "large" : "preview"))} onError={() => {
          if (large) {
            setLarge(undefined);
            setLargeUnavailable(true);
          }
        }} />}
        </div>
        </MediaViewerFrame>}
      </dialog>;
    return <>
      {renderPhotoLink ? <>
        <div className="mtg-photo-link" style={frame}>{renderPhotoLink(image)}</div>
        <button type="button" className="mtg-action" data-photo-opener={openMessage ? messageId : undefined} onClick={enlarge}>{tr("Enlarge Telegram photo")}</button>
      </> : <button ref={opener} type="button" className={`mtg-photo-open${inConversation ? " mtg-photo-fill" : ""}`} style={frame}
        aria-label={tr("Enlarge Telegram photo")} aria-expanded={inConversation ? expanded : undefined}
        data-photo-opener={openMessage ? messageId : undefined} onClick={enlarge}>
        {image}
      </button>}
      {!expanded && motion}
      {photoViewer}
      {drawing && <PhotoEditor initialMode="draw" source={drawing.source} close={() => setDrawing(undefined)} apply={async (jpeg) => {
        if (!drawReply || !await drawReply.stage(drawing.id, jpeg)) throw new Error("Could not stage drawn photo.");
        setDrawing(undefined);
        closePhoto(false);
      }} />}
    </>;
  }
  if (canObserve && status !== "error") return <div ref={placeholder} className={`mtg-photo-placeholder${inConversation ? " mtg-photo-fill" : ""}`} style={frame}
    aria-label={status === "loading" ? tr("Loading photo") : undefined} />;
  return <div className="mtg-photo-state">
    <button className="mtg-action" type="button" data-photo-opener={openMessage && status !== "loading" ? messageId : undefined}
      disabled={status === "loading"} onClick={() => void open()}>
      {status === "loading" ? tr("Loading photo…") : status === "error" ? tr("Retry photo") : tr("Show photo")}
    </button>
    {status === "error" && <><span role="alert">{tr("Photo unavailable.")}</span>{renderPhotoLink?.()}</>}
  </div>;
}

export function photoSource(photo: TelegramPhoto) {
  return `data:${photo.mime};base64,${photo.base64}`;
}

function clampPhotoZoom(value: number) {
  return Math.max(1, Math.min(4, value));
}

type PhotoPoint = { x: number; y: number };

function ZoomablePhoto({ source, move, recognize, recognitionSize, onError, recognitionPanel }: {
  source: string; move: (offset: -1 | 1) => void; recognize?: () => Promise<PhotoTextResult | null>;
  recognitionSize: PhotoSize; onError?: () => void; recognitionPanel: HTMLDivElement | null;
}) {
  const { t: tr } = useTelegramLocale();
  const [zoom, setZoom] = useState(1);
  const [detected, setDetected] = useState<{ source: string; lines: PhotoTextResult["lines"] }>();
  const textInput = useRef<HTMLTextAreaElement>(null);
  const lines = recognize && detected?.source === source ? detected.lines : [];
  const canRecognize = recognize !== undefined;
  useEffect(() => {
    if (!canRecognize) setDetected(undefined);
  }, [canRecognize]);
  const viewport = useRef<HTMLDivElement>(null);
  const touches = useRef(new Map<number, PhotoPoint>());
  const swipeStart = useRef<PhotoPoint | undefined>(undefined);
  const pinch = useRef<{ distance: number; zoom: number } | undefined>(undefined);

  useEffect(() => {
    const panel = viewport.current;
    if (!panel) return;
    const magnify = (event: WheelEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || !event.cancelable) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? panel.clientHeight : 1;
      setZoom((value) => clampPhotoZoom(value * Math.exp(-event.deltaY * unit / 250)));
    };
    panel.addEventListener("wheel", magnify, { passive: false });
    return () => panel.removeEventListener("wheel", magnify);
  }, []);

  function distance() {
    const [first, second] = touches.current.values();
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  }

  function startTouch(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    touches.current.set(event.pointerId, point);
    if (touches.current.size === 1) swipeStart.current = zoom === 1 ? point : undefined;
    else {
      swipeStart.current = undefined;
      if (touches.current.size === 2) pinch.current = { distance: Math.max(1, distance()), zoom };
    }
  }

  function moveTouch(event: PointerEvent<HTMLDivElement>) {
    const previous = touches.current.get(event.pointerId);
    if (!previous) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && touches.current.size === 2) {
      setZoom(clampPhotoZoom(pinch.current.zoom * distance() / pinch.current.distance));
    } else if (touches.current.size === 1 && zoom > 1) {
      event.currentTarget.scrollLeft -= event.clientX - previous.x;
      event.currentTarget.scrollTop -= event.clientY - previous.y;
    }
  }

  function endTouch(event: PointerEvent<HTMLDivElement>) {
    if (!touches.current.delete(event.pointerId)) return;
    const start = swipeStart.current;
    swipeStart.current = undefined;
    pinch.current = undefined;
    if (event.type !== "pointerup" || !start || touches.current.size || zoom !== 1) return;
    const deltaX = event.clientX - start.x;
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > 1.5 * Math.abs(event.clientY - start.y)) move(deltaX < 0 ? 1 : -1);
  }

  return <>
    <div className="mtg-photo-navigation mtg-photo-zoom-controls" role="group" aria-label={tr("Photo zoom")}>
      <button type="button" className="mtg-photo-icon-button" aria-label={tr("Zoom out")} title={tr("Zoom out")} disabled={zoom <= 1}
        onClick={() => setZoom((value) => Math.max(1, value - 0.5))}><Minus size={16} aria-hidden="true" /></button>
      <button type="button" className="mtg-photo-icon-button" aria-label={tr("Reset photo zoom")} title={tr("Fit to view")} disabled={zoom === 1}
        onClick={() => setZoom(1)}>{zoom === 1 ? <Maximize size={16} aria-hidden="true" /> : `${Math.round(zoom * 100)}%`}</button>
      <button type="button" className="mtg-photo-icon-button" aria-label={tr("Zoom in")} title={tr("Zoom in")} disabled={zoom >= 4}
        onClick={() => setZoom((value) => Math.min(4, value + 0.5))}><Plus size={16} aria-hidden="true" /></button>
    </div>
    <div ref={viewport} className="mtg-photo-zoom-viewport" tabIndex={zoom > 1 ? 0 : undefined} aria-label={zoom > 1 ? tr("Zoomed photo") : undefined}
      onPointerDown={startTouch} onPointerMove={moveTouch} onPointerUp={endTouch} onPointerCancel={endTouch} onLostPointerCapture={endTouch}>
      <div className="mtg-photo-image" style={{ zoom }}>
        <img src={source} alt={tr("Enlarged Telegram photo")} draggable={false} onError={onError} />
        {lines.map((line, index) => <button key={index} type="button" className="mtg-photo-text-region"
          aria-label={tr("Select text: {0}", [line.text])}
          style={{ left: `${line.x * 100}%`, top: `${line.y * 100}%`, width: `${line.width * 100}%`, height: `${line.height * 100}%` }}
          onClick={() => {
            const input = textInput.current;
            if (!input) return;
            const start = lines.slice(0, index).reduce((offset, item) => offset + item.text.length + 1, 0);
            input.focus();
            input.setSelectionRange(start, start + line.text.length);
          }} />)}
      </div>
    </div>
    {recognize && recognitionPanel && createPortal(<PhotoText key={recognitionSize} input={textInput} recognize={recognize}
      onResult={(result) => setDetected({ source, lines: result.lines })} />, recognitionPanel)}
  </>;
}
