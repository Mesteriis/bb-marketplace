import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatBackgroundFill, ChatBackgroundView, TelegramPhoto, WallpaperLinkPreview, WallpaperPattern, WallpaperPatternAsset } from "../core/contract.ts";
import { canonicalTelegramWallpaperLink } from "../core/public-chat-reference.ts";
import { photoSource } from "./photo-preview.tsx";
import { wallpaperPatternUrl } from "./wallpaper-pattern.ts";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";

type SaveResult = "saved" | "changed" | "unavailable";
type LinkedWallpaper = { link: string; revision: string };
type WallpaperReview = WallpaperLinkPreview & { patternUrl?: string };

export type ChatBackgroundActions = {
  load: (id: string) => Promise<ChatBackgroundView | null>;
  save: (id: string, expected: string | null, color: string | null) => Promise<"saved" | "changed" | "unavailable">;
  savePhoto?: (id: string, expected: string | null, base64: string) => Promise<"saved" | "changed" | "unavailable">;
  loadPhoto?: (id: string, revision: string) => Promise<TelegramPhoto>;
  loadPattern?: (id: string, revision: string) => Promise<WallpaperPatternAsset>;
  previewLink?: (id: string, link: string) => Promise<WallpaperLinkPreview | null>;
  saveLink?: (id: string, expected: string | null, link: string, revision: string) => Promise<SaveResult>;
};

export function backgroundFillStyle(fill: ChatBackgroundFill) {
  if (fill.kind === "solid") return fill.color;
  if (fill.kind === "linear") return `linear-gradient(${(180 + fill.rotation) % 360}deg, ${fill.top}, ${fill.bottom})`;
  const positions = ["15% 15%", "85% 15%", "85% 85%"];
  return [...fill.colors.slice(0, -1).map((color, index) =>
    `radial-gradient(ellipse at ${positions[index]}, ${color}, transparent 75%)`), fill.colors.at(-1)].join(", ");
}

export function WallpaperPatternLayer({ pattern, url, preview = false }: { pattern: WallpaperPattern; url: string; preview?: boolean }) {
  const { t: tr } = useTelegramLocale();
  return <div className={`mtg-wallpaper-pattern${preview ? " mtg-wallpaper-fill" : ""}`}
    role={preview ? "img" : undefined} aria-label={preview ? tr("Telegram pattern wallpaper preview") : undefined}
    aria-hidden={preview ? undefined : true} data-inverted={pattern.inverted || undefined}
    style={{ "--mtg-pattern-fill": backgroundFillStyle(pattern.fill), "--mtg-pattern-mask": `url("${url}")`,
      "--mtg-pattern-opacity": pattern.intensity / 100 } as CSSProperties} />;
}

function prepareWallpaperReview(preview: WallpaperLinkPreview | null): WallpaperReview | undefined {
  if (!preview || !("asset" in preview)) return preview ?? undefined;
  const patternUrl = wallpaperPatternUrl(preview.asset);
  if (patternUrl) return { ...preview, patternUrl };
}

function WallpaperArtwork({ review }: { review: WallpaperReview }) {
  const { t: tr } = useTelegramLocale();
  return <div className="mtg-background-preview" data-blurred={"photo" in review && review.blurred || undefined}>
    {"photo" in review ? <img className="mtg-photo" alt={tr("Telegram wallpaper preview")} src={photoSource(review.photo)} />
      : "fill" in review ? <div className="mtg-wallpaper-fill" role="img" aria-label={tr("Telegram color wallpaper preview")}
        style={{ background: backgroundFillStyle(review.fill) }} />
        : review.patternUrl && <WallpaperPatternLayer pattern={review.pattern} url={review.patternUrl} preview />}
  </div>;
}

export function LinkedWallpaperDialog({ id, name, link, actions, chooseChat, close }: {
  id: string;
  name: string;
  link: string;
  actions: ChatBackgroundActions;
  chooseChat?: () => void;
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ review: WallpaperReview; expected: string | null }>();
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "changed" | "failed">("loading");
  useLayoutEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  useLayoutEffect(() => { if (status === "saved") closeButton.current?.focus(); }, [status]);
  useEffect(() => {
    let current = true;
    void Promise.all([actions.load(id), actions.previewLink?.(id, link)]).then(([background, preview]) => {
      if (!current) return;
      const review = prepareWallpaperReview(preview ?? null);
      if (!background || !review) { setStatus("failed"); return; }
      setSnapshot({ review, expected: background.revision });
      setStatus("ready");
    }, () => { if (current) setStatus("failed"); });
    return () => { current = false; };
  }, [actions, attempt, id, link]);

  async function apply() {
    if (status !== "ready" || !snapshot || !actions.saveLink || saving.current) return;
    saving.current = true;
    setStatus("saving");
    try {
      const result = await actions.saveLink(id, snapshot.expected, link, snapshot.review.revision);
      setStatus(result === "saved" || result === "changed" ? result : "failed");
    } catch { setStatus("failed"); }
    finally { saving.current = false; }
  }

  return <dialog ref={dialog} className="mtg-agent-settings mtg-linked-wallpaper" aria-label={tr("Telegram wallpaper")}
    onClose={close} onCancel={(event) => { if (saving.current) event.preventDefault(); }}>
    <h2>{tr("Telegram wallpaper")}</h2>
    <p>{tr("Apply for yourself in ")}<bdi>{name}</bdi>.</p>
    {snapshot && <WallpaperArtwork review={snapshot.review} />}
    {status === "loading" && <p role="status">{tr("Loading wallpaper…")}</p>}
    {status === "saving" && <p role="status">{tr("Applying wallpaper…")}</p>}
    {status === "saved" && <p role="status">{tr("Chat background saved.")}</p>}
    {status === "changed" && <p role="alert">{tr("The wallpaper or chat background changed. Load a new preview before applying.")}</p>}
    {status === "failed" && <p role="alert">{tr("Could not review or apply the wallpaper in this chat.")}</p>}
    <div className="mtg-chat-detail-actions">
      {status === "ready" && <button type="button" className="mtg-action" onClick={() => void apply()}>{tr("Apply wallpaper for me")}</button>}
      {(status === "changed" || status === "failed") && <button type="button" className="mtg-action" onClick={() => {
        setSnapshot(undefined);
        setStatus("loading");
        setAttempt((n) => n + 1);
      }}>{tr("Reload wallpaper preview")}</button>}
      {chooseChat && status !== "saved" && <button type="button" className="mtg-action" disabled={status === "saving"}
        onClick={chooseChat}>{tr("Choose another chat")}</button>}
      <button ref={closeButton} type="button" autoFocus className="mtg-action" disabled={status === "saving"}
        onClick={() => dialog.current?.close()}>{status === "saved" ? tr("Done") : tr("Close wallpaper preview")}</button>
    </div>
  </dialog>;
}

export function ChatBackground({ id, actions }: { id: string; actions: ChatBackgroundActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatBackgroundView | null>();
  const [color, setColor] = useState("#406387");
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<string>();
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void actions.load(id).then((result) => {
      if (!active) return;
      setView(result);
      setColor(result?.color ?? "#406387");
    }, () => { if (active) setError("Could not load the chat background."); });
    return () => { active = false; };
  }, [open, id, actions, revision]);

  async function prepare(file: File | undefined) {
    setPreview(undefined);
    setNotice("");
    setError("");
    if (!file) return;
    if (!isPhotoMimeType(file.type) || !file.size || file.size > maxOriginalPhotoBytes) {
      setError("Choose a JPEG, PNG, or WebP up to 64 MiB.");
      return;
    }
    setPreparing(true);
    try { setPreview(await preparePhoto(file)); }
    catch { setError("Could not prepare the background photo."); }
    finally { setPreparing(false); }
  }

  async function save(change: (expected: string | null) => Promise<SaveResult>) {
    if (!view || saving || preparing) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await change(view.revision);
      if (result === "saved") {
        setPreview(undefined);
        setNotice("Chat background saved.");
        setRevision((value) => value + 1);
      } else if (result === "changed") {
        setError("The background changed in Telegram. Review the updated settings.");
        setRevision((value) => value + 1);
      } else {
        setError("Telegram could not change this background.");
      }
    } catch {
      setError("Telegram did not confirm the change. Refresh before retrying.");
      setRevision((value) => value + 1);
    } finally {
      setSaving(false);
    }
  }

  return <details onToggle={(event) => {
    if (event.target !== event.currentTarget || event.currentTarget.open === open) return;
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) { setView(undefined); setError(""); setNotice(""); }
  }}>
    <summary>{tr("Chat background")}</summary>
    {open && <>
      {view === undefined && !error && <p role="status">{tr("Loading chat background…")}</p>}
      {view === null && <p>{tr("Background settings are unavailable for this chat.")}</p>}
      {view && <form onSubmit={(event) => { event.preventDefault(); void save((expected) => actions.save(id, expected, color)); }}>
        <label>{tr("Background color ")}<input type="color" value={color} disabled={saving} onChange={(event) => setColor(event.currentTarget.value)} /></label>
        <p>{tr("The selected color applies only to you.")}</p>
        {view.revision && !view.color && <p>{tr("This chat currently has a custom background.")}</p>}
        <button type="submit" className="mtg-action" disabled={saving || color === view.color}>{tr("Apply background color")}</button>
        {view.revision && <button type="button" className="mtg-action" disabled={saving}
          onClick={() => void save((expected) => actions.save(id, expected, null))}>{tr("Reset background")}</button>}
      </form>}
      {view && actions.savePhoto && <div>
        <label>{tr("Choose background photo ")}<input type="file" accept={photoAccept} disabled={preparing || saving}
          onChange={(event) => void prepare(event.currentTarget.files?.[0])} /></label>
        {preparing && <p role="status">{tr("Preparing background photo…")}</p>}
        {preview && <div className="mtg-background-preview">
          <img className="mtg-photo" alt={tr("Background photo preview")} src={`data:image/jpeg;base64,${preview}`} />
          <button type="button" className="mtg-action" disabled={saving}
            onClick={() => void save((expected) => actions.savePhoto!(id, expected, preview))}>{tr("Apply background photo")}</button>
          <button type="button" className="mtg-action" disabled={saving} onClick={() => setPreview(undefined)}>{tr("Discard photo")}</button>
        </div>}
      </div>}
      {view && actions.previewLink && actions.saveLink && <WallpaperLinkPicker key={revision}
        busy={saving || preparing} load={(link) => actions.previewLink!(id, link)}
        apply={({ link, revision }) => void save((expected) => actions.saveLink!(id, expected, link, revision))} />}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={saving} onClick={() => {
        setError("");
        setView(undefined);
        setRevision((value) => value + 1);
      }}>{tr("Refresh background")}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}

function WallpaperLinkPicker({ busy, load, apply }: {
  busy: boolean;
  load: (link: string) => Promise<WallpaperLinkPreview | null>;
  apply: (target: LinkedWallpaper) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [input, setInput] = useState("");
  const [review, setReview] = useState<WallpaperReview & LinkedWallpaper>();
  const [status, setStatus] = useState<"loading" | "unsupported" | "failed">();
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const link = canonicalTelegramWallpaperLink(input.trim());
  return <form className="mtg-wallpaper-link" onSubmit={async (event) => {
    event.preventDefault();
    if (!link || busy || status === "loading") return;
    const generation = ++request.current;
    setReview(undefined);
    setStatus("loading");
    try {
      const result = await load(link);
      if (request.current !== generation) return;
      const preview = prepareWallpaperReview(result);
      if (preview) setReview({ ...preview, link });
      setStatus(preview ? undefined : "unsupported");
    } catch {
      if (request.current === generation) setStatus("failed");
    }
  }}>
    <label>{tr("Telegram wallpaper link ")}<input type="text" inputMode="url" value={input} maxLength={512}
      disabled={busy} onChange={(event) => {
        request.current += 1;
        setInput(event.currentTarget.value);
        setReview(undefined);
        setStatus(undefined);
      }} /></label>
    <button type="submit" className="mtg-action" disabled={!link || busy || status === "loading"}>{tr("Preview wallpaper")}</button>
    {status === "loading" && <p role="status">{tr("Loading wallpaper…")}</p>}
    {status === "unsupported" && <p role="alert">{tr("This Telegram link does not contain a supported wallpaper.")}</p>}
    {status === "failed" && <p role="alert">{tr("Could not load this Telegram wallpaper.")}</p>}
    {review && <div className="mtg-wallpaper-review">
      <WallpaperArtwork review={review} />
      <button type="button" className="mtg-action" disabled={busy} onClick={() => apply(review)}>{tr("Apply wallpaper for me")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Discard wallpaper")}</button>
    </div>}
  </form>;
}
