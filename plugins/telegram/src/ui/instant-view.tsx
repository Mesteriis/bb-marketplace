import { useTelegramLocale } from "./i18n/index.tsx";
import { DocumentButton } from "./document-button.tsx";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { ArticleButton, ArticleMapPoint, ChatJoinResult, InstantViewArticle, InstantViewDateRange, InstantViewFormulaRange, InstantViewIconImage, InstantViewIconRange, InstantViewJoinTarget, InstantViewList, InstantViewMentionRange, InstantViewTagRange, PhotoSize, PlaybackMime, TelegramPhoto } from "../core/contract.ts";
import { webLink, type MessageLink } from "../core/message-links.ts";
import { MessageText } from "./message-text.tsx";
import { buttonLabel, CopyTextAction, LinkAction } from "./message-action-button.tsx";
import { PhotoPreview, type AlbumPhoto } from "./photo-preview.tsx";
import { canonicalTelegramContentLink, telegramInstantViewLink } from "../core/telegram-content-link.ts";
import { canonicalTelegramBotStartLink, canonicalTelegramMessageLink, canonicalTelegramPublicChatLink } from "../core/public-chat-reference.ts";
import { OpenTelegramMessageLink, TelegramMessageLink, type FollowTelegramMessageLink } from "./telegram-message-link.tsx";
import { Avatar, type AvatarLoader } from "./avatar.tsx";
import { MapControls } from "./location-card.tsx";
import { MediaPlayer } from "./media-player.tsx";
import { spoilerRanges } from "../core/message-spoilers.ts";
import { tabSeparatedTableText } from "../core/table-text.ts";
import { miniAppFrameEvent } from "../core/mini-app.ts";
import { MathFormula } from "./math-formula.tsx";
import { StaticTelegramMarkup } from "./static-telegram-markup.tsx";

export type LoadInstantView = (url: string) => Promise<InstantViewArticle | null>;
export const InstantViewLoader = createContext<LoadInstantView | undefined>(undefined);
export const OpenInstantView = createContext<((url: string, opener: HTMLButtonElement) => void) | undefined>(undefined);
export const InstantViewTagSearch = createContext<((tag: string) => void) | undefined>(undefined);
export const InstantViewShare = createContext<((url: string) => void) | undefined>(undefined);
type OpenInstantViewMention = (url: string, userId: number, signal: AbortSignal) => Promise<boolean>;
export const InstantViewMentionOpen = createContext<OpenInstantViewMention | undefined>(undefined);
export type InstantViewJoinActions = {
  review: (url: string, target: string) => Promise<InstantViewJoinTarget | null>;
  join: (url: string, target: string, expected: InstantViewJoinTarget) => Promise<ChatJoinResult>;
};
export const InstantViewJoin = createContext<InstantViewJoinActions | undefined>(undefined);
export type LoadInstantViewPhoto = (url: string, fileId: number, size?: PhotoSize) => Promise<TelegramPhoto>;
export const InstantViewPhotoLoader = createContext<LoadInstantViewPhoto | undefined>(undefined);
export type LoadInstantViewIcon = (url: string, fileId: number) => Promise<InstantViewIconImage>;
export const InstantViewIconLoader = createContext<LoadInstantViewIcon | undefined>(undefined);
const ArticleUrl = createContext("");
export type LoadInstantViewPlayback = (url: string, fileId: number) => Promise<string>;
export const InstantViewPlaybackLoader = createContext<LoadInstantViewPlayback | undefined>(undefined);

export type SaveInstantViewDocument = (url: string, fileId: number) => Promise<boolean>;
export const InstantViewDocumentSaver = createContext<SaveInstantViewDocument | undefined>(undefined);

export type LoadInstantViewMap = (url: string, point: ArticleMapPoint) => Promise<string>;
export const InstantViewMapLoader = createContext<LoadInstantViewMap | undefined>(undefined);

function articlePhotoId(fileId: number, index?: number) {
  return index === undefined ? String(fileId) : `${fileId}:${index}`;
}

function ArticleJoin({ url, target }: { url: string; target: string }) {
  const { t: tr } = useTelegramLocale();
  const actions = useContext(InstantViewJoin);
  const locked = useRef(false);
  const [review, setReview] = useState<InstantViewJoinTarget>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChatJoinResult | "unavailable">();
  if (!actions) return null;
  async function check() {
    if (!actions || locked.current) return;
    locked.current = true;
    setBusy(true);
    setResult(undefined);
    const next = await actions.review(url, target).catch(() => null);
    setReview(next ?? undefined);
    if (!next) setResult("unavailable");
    locked.current = false;
    setBusy(false);
  }
  async function confirm() {
    if (!actions || !review || locked.current) return;
    locked.current = true;
    setBusy(true);
    setResult(await actions.join(url, target, review).catch(() => "unknown" as const));
    setReview(undefined);
    locked.current = false;
    setBusy(false);
  }
  const status = result === "joined" ? "Joined." : result === "requested" ? "Join request sent."
    : result === "verification_required" ? "Open Telegram to complete join verification."
    : result === "unavailable" ? "Joining is unavailable." : result === "refused" ? "Telegram refused the join."
    : result ? "Telegram did not confirm membership. Check the chat before trying again." : undefined;
  return <>{review ? <>
    <span>{review.mode === "request" ? tr("Request to join") : tr("Join")} <bdi>{review.name}</bdi>?</span>
    <button type="button" className="mtg-action" autoFocus disabled={busy} onClick={() => void confirm()}>
      {review.mode === "request" ? tr("Send join request") : tr("Confirm join")}
    </button>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel join")}</button>
  </> : (!result || result === "refused" || result === "unavailable") && <button type="button" className="mtg-action"
    disabled={busy} onClick={() => void check()}>{tr("Review join")}</button>}
  {status && <span role="status">{tr(status)}</span>}</>;
}

const ArticleClock = createContext(0);

function ArticleClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const sync = () => {
      clearInterval(timer);
      if (document.hidden) return;
      tick();
      timer = setInterval(tick, 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return <ArticleClock.Provider value={now}>{children}</ArticleClock.Provider>;
}

function RelativeArticleDate({ unixTime }: { unixTime: number }) {
  const delta = unixTime - useContext(ArticleClock);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600],
    ["minute", 60], ["second", 1]] as const;
  const [unit, seconds] = units.find(([, scale]) => Math.abs(delta) >= scale) ?? units[5];
  return new Intl.RelativeTimeFormat().format(Math.trunc(delta / seconds), unit);
}

function ArticleDate({ unixTime, format, original }: InstantViewDateRange & { original: string }) {
  const { locale: uiLocale } = useTelegramLocale();
  const date = new Date(unixTime * 1000);
  let label: ReactNode = original;
  if (format.kind === "absolute" && (format.date !== "none" || format.time !== "none" || format.weekday)) {
    label = new Intl.DateTimeFormat(undefined, {
      ...(format.date !== "none" && { year: "numeric", month: format.date === "long" ? "long" : "numeric", day: "numeric" }),
      ...(format.weekday && { weekday: "long" }),
      ...(format.time !== "none" && { hour: "numeric", minute: "2-digit" }),
      ...(format.time === "long" && { second: "2-digit" }),
    }).format(date);
  } else if (format.kind === "relative") {
    label = <RelativeArticleDate unixTime={unixTime} />;
  }
  return <time dateTime={date.toISOString()} title={date.toLocaleString(uiLocale)}>{label}</time>;
}

function ArticleIcon({ fileId, width, height }: InstantViewIconRange) {
  const url = useContext(ArticleUrl);
  const load = useContext(InstantViewIconLoader);
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!url || !load || !ref.current) return;
    let active = true;
    const fetch = () => {
      void load(url, fileId).then(({ mime, base64 }) => {
        if (active) setSrc(`data:${mime};base64,${base64}`);
      }, () => {});
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      if (!active || !entries.some(({ isIntersecting }) => isIntersecting)) return;
      observer?.disconnect();
      fetch();
    }) : undefined;
    if (observer) observer.observe(ref.current);
    else fetch();
    return () => { active = false; observer?.disconnect(); };
  }, [url, fileId, load]);
  return <span ref={ref} className="mtg-article-icon" style={{ width: width || "1em", height: height || "1em" }} aria-hidden="true">
    {src && <img src={src} alt="" />}
  </span>;
}

type ArticleInline = Pick<ComponentProps<typeof MessageText>, "text" | "styles" | "links" | "customEmoji">
  & { formulas?: readonly InstantViewFormulaRange[]; dates?: readonly InstantViewDateRange[]; icons?: readonly InstantViewIconRange[];
    inlineButtons?: readonly { offset: number; length: number; button: ArticleButton }[]; tags?: readonly InstantViewTagRange[];
    mentions?: readonly InstantViewMentionRange[] };

function ArticleMention({ label, userId, open, style, className = "mtg-instant-view-reference" }: {
  label: ReactNode; userId: number; open: OpenInstantViewMention; className?: string;
  style?: Extract<ArticleButton, { kind: "profile" }>["style"];
}) {
  const { t: tr } = useTelegramLocale();
  const url = useContext(ArticleUrl);
  const request = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => () => { request.current?.abort(); }, [url, userId]);
  async function openProfile() {
    if (request.current && !request.current.signal.aborted) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setUnavailable(false);
    const opened = await open(url, userId, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    request.current = undefined;
    setBusy(false);
    setUnavailable(!opened);
  }
  return <><button type="button" className={className} data-button-style={style} title={tr("Open Telegram profile")} disabled={busy}
    onClick={() => void openProfile()}>{label}</button>{unavailable && <span role="status">{tr(" Telegram profile unavailable.")}</span>}</>;
}

function ArticleAction({ button, renderLink }: {
  button: ArticleButton; renderLink: NonNullable<ComponentProps<typeof MessageText>["renderLink"]>;
}) {
  const openProfile = useContext(InstantViewMentionOpen);
  if (button.kind === "copy") return <CopyTextAction button={button} />;
  if (button.kind === "disabled") return <button type="button" className="mtg-action" data-button-style={button.style}
    disabled><MessageText {...buttonLabel(button)} inline /></button>;
  if (button.kind === "profile") return openProfile
    ? <ArticleMention className="mtg-action" style={button.style} label={<MessageText {...buttonLabel(button)} inline />}
      userId={button.userId} open={openProfile} />
    : <span>{button.label}</span>;
  return <LinkAction button={button} renderLink={renderLink} />;
}

function ArticleText({ text, formulas, dates, icons, inlineButtons, tags, mentions, styles, links, customEmoji, renderLink, onRevealSpoiler }: ArticleInline & {
  renderLink: NonNullable<ComponentProps<typeof MessageText>["renderLink"]>;
  onRevealSpoiler?: ComponentProps<typeof MessageText>["onRevealSpoiler"];
}) {
  const { t: tr } = useTelegramLocale();
  const searchTag = useContext(InstantViewTagSearch);
  const openMention = useContext(InstantViewMentionOpen);
  const replacements = text ? [
    ...(inlineButtons ?? []).map(({ offset, length, button }) => ({ offset, length,
      content: <ArticleAction button={button} renderLink={renderLink} /> })),
    ...(formulas ?? []).map(({ offset, length }) => ({ offset, length,
      content: <MathFormula expression={text.slice(offset, offset + length)} /> })),
    ...(dates ?? []).map((range) => ({ offset: range.offset, length: range.length,
      content: <ArticleDate {...range} original={text.slice(range.offset, range.offset + range.length)} /> })),
    ...(icons ?? []).map((icon) => ({ offset: icon.offset, length: 1,
      content: <ArticleIcon key={icon.fileId} {...icon} /> })),
  ] : undefined;
  const outerLinks = links?.filter((link) => !inlineButtons?.some((button) =>
    link.offset < button.offset + button.length && button.offset < link.offset + link.length));
  function addAnnotation(offset: number, length: number, render: (label: ReactNode) => React.JSX.Element) {
    if (!replacements || !text) return;
    const end = offset + length;
    if (end > text.length || [...(outerLinks ?? []), ...replacements].some((item) =>
      item.offset < end && offset < item.offset + item.length)) return;
    const labelStyles = styles?.flatMap((item) => {
      const start = Math.max(item.offset, offset);
      const right = Math.min(item.offset + item.length, end);
      return right > start && item.style !== "spoiler" ? [{ offset: start - offset, length: right - start, style: item.style }] : [];
    });
    replacements.push({ offset, length, content: render(<MessageText text={text.slice(offset, end)} styles={labelStyles} inline />) });
  }
  if (searchTag) for (const { offset, length, tag } of tags ?? []) {
    addAnnotation(offset, length, (label) => <button type="button" className="mtg-instant-view-reference"
      title={tr("Search public posts for {0}", [tag])} onClick={() => searchTag(tag)}>{label}</button>);
  }
  if (openMention) for (const { offset, length, userId } of mentions ?? []) {
    addAnnotation(offset, length, (label) => <ArticleMention label={label} userId={userId} open={openMention} />);
  }
  return <MessageText text={text} styles={styles} links={outerLinks} customEmoji={customEmoji} renderLink={renderLink}
    replacements={replacements} inline allowContactLinks onRevealSpoiler={onRevealSpoiler} />;
}

function ArticleCode({ block, path, renderLink }: {
  block: Extract<InstantViewArticle["blocks"][number], { kind: "code" }>;
  path: string;
  renderLink: NonNullable<ComponentProps<typeof MessageText>["renderLink"]>;
}) {
  const { text, styles, language } = block;
  const [reveal, setReveal] = useState<{ text: string; ranges: Set<string> }>();
  const hidden = spoilerRanges(text, styles).some(({ start, end }) =>
    reveal?.text !== text || !reveal.ranges.has(`${start}:${end}`));
  return <div data-article-block={path} tabIndex={-1} className="mtg-instant-view-code">
    <div className="mtg-instant-view-actions">
      {language && <span><bdi>{language}</bdi></span>}
      <CopyTextAction button={{ label: "Copy code", text }}
        disabledReason={hidden ? "Reveal all spoilers to copy the code." : undefined} />
    </div>
    <pre dir="ltr"><code><ArticleText {...block} renderLink={renderLink} onRevealSpoiler={({ start, end }) => {
      setReveal((previous) => ({ text, ranges: new Set([...(previous?.text === text ? previous.ranges : []), `${start}:${end}`]) }));
    }} /></code></pre>
  </div>;
}

function ArticleMap({ url, point }: { url: string; point: ArticleMapPoint }) {
  const load = useContext(InstantViewMapLoader);
  const loadPreview = useCallback(() => load!(url, point), [load, url, point]);
  return <MapControls point={point} zoom={point.zoom} dimensions={point.dimensions} load={load ? loadPreview : undefined} />;
}

function ArticlePlayer({ url, fileId, mime, spoiler, loop, autoplay, voiceNote, posterFileId, dimensions, durationSeconds, waveform, audioMetadata, load }: {
  url: string;
  fileId: number;
  mime: PlaybackMime;
  spoiler?: boolean;
  loop?: boolean;
  autoplay?: boolean;
  voiceNote?: boolean;
  posterFileId?: number;
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  waveform?: readonly number[];
  audioMetadata?: { title: string; artist?: string };
  load: LoadInstantViewPlayback;
}) {
  const { t: tr } = useTelegramLocale();
  const [revealed, setRevealed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const region = useRef<HTMLDivElement>(null);
  const loadPhoto = useContext(InstantViewPhotoLoader);
  const [poster, setPoster] = useState<string>();
  const stream = useCallback((source: string, id: string) => load(source, Number(id)), [load]);
  useEffect(() => {
    const target = region.current;
    if (!target || !loadPhoto || posterFileId === undefined || (spoiler && !revealed)) return;
    let active = true;
    let requested = false;
    const requestPoster = () => {
      if (!active || requested) return;
      requested = true;
      void loadPhoto(url, posterFileId).then(({ mime, base64 }) => {
        if (active) setPoster(`data:${mime};base64,${base64}`);
      }, () => {});
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      requestPoster();
    }) : undefined;
    if (observer) observer.observe(target);
    else requestPoster();
    return () => { active = false; observer?.disconnect(); };
  }, [loadPhoto, posterFileId, revealed, spoiler, url]);
  useEffect(() => {
    if (!autoplay || spoiler || !region.current || typeof IntersectionObserver !== "function"
      || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.5);
    }, { threshold: 0.5 });
    observer.observe(region.current);
    const visibilityChanged = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [autoplay, spoiler]);
  if (spoiler && !revealed) return <button type="button" className="mtg-action"
    onClick={() => setRevealed(true)}>{mime === "image/gif" ? tr("Show GIF spoiler") : tr("Show video spoiler")}</button>;
  return <div ref={region}><MediaPlayer chatId={url} messageId={String(fileId)} mime={mime} stream={stream}
    loop={loop} voiceNote={voiceNote} poster={poster} posterSize={dimensions} durationSeconds={durationSeconds} waveform={waveform}
    audioMetadata={audioMetadata} autoplay={autoplay && !spoiler ? visible && pageVisible : undefined} /></div>;
}

type ArticleMedia = Extract<InstantViewArticle["blocks"][number], { kind: "photo" | "video" | "audio" | "document" | "missingMedia" | "map" }>;

function ArticleList({ items, renderItem }: {
  items: InstantViewList["items"];
  renderItem: (blocks: InstantViewArticle["blocks"], index: number) => ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const ordered = items.some(({ numbering }) => numbering);
  const List = ordered ? "ol" : "ul";
  return <List className="mtg-rich-list" role="list" type={ordered ? items[0]?.numbering : undefined}>
    {items.map(({ label, numbering, value, checked, blocks }, index) => <li key={index} value={numbering ? value : undefined}
      data-numbering={ordered ? numbering ?? "bullet" : undefined}
      data-custom-marker={!!label || checked !== undefined || undefined}>
      {label && <bdi>{label} </bdi>}
      {checked !== undefined && <input type="checkbox" disabled checked={checked} aria-label={tr("Task status")} />}
      {renderItem(blocks, index)}
    </li>)}
  </List>;
}

export function InstantViewButton({ url, local = false }: { url: string; local?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const load = useContext(InstantViewLoader);
  const openArticle = useContext(OpenInstantView);
  const [open, setOpen] = useState(false);
  if (!load) return null;
  return <>
    <button type="button" className="mtg-action" aria-haspopup="dialog" onClick={(event) => {
      if (openArticle && !local) openArticle(url, event.currentTarget);
      else setOpen(true);
    }}>{tr("Instant View")}</button>
    {open && <InstantViewDialog url={url} load={load} close={() => setOpen(false)} />}
  </>;
}

type ArticleDetailsState = Map<string, { label: string | null | undefined; open: boolean }>;
type ArticleReadingAnchor = { tag: string; text: string; offset: number };
type ArticleReturnLink = { index: number; href: string };
type ArticleSectionVisit = { top: number; link: ArticleReturnLink; details: ArticleDetailsState; slides?: Record<string, number> };
type ArticlePage = {
  id: number;
  url: string; article?: InstantViewArticle | null; top?: number; returnLink?: ArticleReturnLink; detailsState?: ArticleDetailsState;
  slides?: Record<string, number>;
  sectionHistory?: ArticleSectionVisit[];
  changesReturnTop?: number;
  retry?: "loading" | "failed";
  readingAnchor?: ArticleReadingAnchor;
};

type ArticleContinuation = { pages: ArticlePage[]; scale: ArticleScale };
type ArticleHandoff = ArticleContinuation & { scope: string; path: string; width: number; timer: number };
let pendingArticleHandoff: ArticleHandoff | undefined;

export function resumeInstantView(scope: string | undefined): ArticleContinuation | undefined {
  const handoff = pendingArticleHandoff;
  if (scope && handoff?.scope === scope && handoff.width === window.innerWidth && handoff.path === window.location.pathname) return handoff;
}

function clearArticleHandoff(handoff: ArticleContinuation | undefined) {
  if (!pendingArticleHandoff || pendingArticleHandoff !== handoff) return;
  window.clearTimeout(pendingArticleHandoff.timer);
  pendingArticleHandoff = undefined;
}

function handOffArticle(scope: string, snapshot: ArticleContinuation) {
  clearArticleHandoff(pendingArticleHandoff);
  const timer = window.setTimeout(() => { pendingArticleHandoff = undefined; }, 3000);
  pendingArticleHandoff = { ...snapshot, scope, path: window.location.pathname, width: window.innerWidth, timer };
}

type ArticleSection = { path: string; slide?: { gallery: string; index: number } };
function articleDetailsState(viewer: HTMLDialogElement): ArticleDetailsState {
  return new Map(Array.from(viewer.querySelectorAll<HTMLDetailsElement>("details[data-article-block]"),
    (section) => [section.dataset.articleBlock!, { label: section.firstElementChild?.textContent, open: section.open }]));
}

function restoreArticleDetails(viewer: HTMLDialogElement, state: ArticleDetailsState) {
  viewer.querySelectorAll<HTMLDetailsElement>("details[data-article-block]").forEach((section) => {
    const saved = state.get(section.dataset.articleBlock!);
    if (saved && saved.label === section.firstElementChild?.textContent) section.open = saved.open;
  });
}

const readableArticleBlocks = "[data-article-block]:is(p,h1,h2,h3,h4,h5,h6,pre,blockquote,footer,td,th)";

function captureArticleReadingAnchor(article: HTMLElement | null, viewer: HTMLDialogElement, toolbar: HTMLElement | null) {
  if (!article || !toolbar || viewer.scrollTop <= 0) return;
  const readingLine = toolbar.getBoundingClientRect().bottom;
  const bottom = viewer.getBoundingClientRect().bottom;
  const blocks = Array.from(article.querySelectorAll<HTMLElement>(readableArticleBlocks));
  for (const block of blocks) {
    const text = block.textContent?.trim();
    const bounds = block.getBoundingClientRect();
    if (!text || text.length > 4096 || bounds.height <= 0 || bounds.bottom <= readingLine || bounds.top >= bottom) continue;
    if (blocks.some((other) => other !== block && other.tagName === block.tagName && other.textContent?.trim() === text)) continue;
    return { tag: block.tagName, text, offset: bounds.top - readingLine };
  }
}

function restoreArticleReadingAnchor(article: HTMLElement, viewer: HTMLDialogElement, toolbar: HTMLElement, anchor: ArticleReadingAnchor) {
  const matches = Array.from(article.querySelectorAll<HTMLElement>(readableArticleBlocks))
    .filter((block) => block.tagName === anchor.tag && block.textContent?.trim() === anchor.text);
  const block = matches.length === 1 ? matches[0] : undefined;
  if (!block) return;
  revealArticleBlock(block, viewer);
  viewer.scrollTop += block.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - anchor.offset;
}

function articleNavigationLinks(viewer: HTMLDialogElement) {
  return Array.from(viewer.querySelectorAll<HTMLAnchorElement>("a[data-article-navigation]"));
}

function findReturnLink(viewer: HTMLDialogElement, source: ArticleReturnLink) {
  const links = articleNavigationLinks(viewer);
  const candidate = links[source.index];
  return candidate?.href === source.href ? candidate : links.find((link) => link.href === source.href);
}

const articleScales = [80, 90, 100, 110, 125, 150, 175, 200] as const;
type ArticleScale = typeof articleScales[number];

function articleAnchor(blocks: InstantViewArticle["blocks"], matches: (anchors?: readonly string[]) => boolean, prefix = ""): ArticleSection | undefined {
  for (const [index, block] of blocks.entries()) {
    const path = prefix + index;
    if (matches(block.anchors)) return { path };
    if (block.kind === "table") {
      for (const [rowIndex, row] of block.rows.entries()) {
        const cellIndex = row.findIndex((cell) => !cell.invisible && matches(cell.anchors));
        if (cellIndex >= 0) return { path: path + ".cell." + rowIndex + "." + cellIndex };
      }
    }
    if (block.kind === "quoteGroup") {
      const paragraph = block.paragraphs.findIndex(({ anchors }) => matches(anchors));
      if (paragraph >= 0) return { path: path + ".quote." + paragraph };
      if (matches(block.credit?.anchors)) return { path: path + ".credit" };
    }
    if (block.kind === "collage" || block.kind === "slideshow") {
      const index = block.media.findIndex((item) => matches(item.anchors));
      if (index >= 0) return { path: path + ".media." + index,
        ...(block.kind === "slideshow" ? { slide: { gallery: path, index } } : {}) };
    }
    if (block.kind === "list") {
      for (const [itemIndex, item] of block.items.entries()) {
        const child = articleAnchor(item.blocks, matches, path + "." + itemIndex + ".");
        if (child !== undefined) return child;
      }
    }
    if (block.kind === "details" || block.kind === "embeddedPost" || block.kind === "richQuote") {
      const child = articleAnchor(block.blocks, matches, path + ".");
      if (child !== undefined) return child;
      if (block.kind === "richQuote" && matches(block.credit?.anchors)) return { path: path + ".credit" };
    }
  }
}

function findArticleSection(article: InstantViewArticle, fragment: string): ArticleSection | undefined {
  let name: string;
  try { name = decodeURIComponent(fragment); }
  catch { return; }
  if (!name) return { path: "0" };
  const normalized = name.normalize("NFC");
  return articleAnchor(article.blocks, (anchors) => anchors?.includes(name) ?? false)
    ?? articleAnchor(article.blocks, (anchors) => anchors?.some((anchor) => anchor.normalize("NFC") === normalized) ?? false);
}

function focusArticleSection(viewer: HTMLDialogElement, path: string) {
  const element = viewer.querySelector<HTMLElement>(`[data-article-block="${path}"]`);
  if (!element) return false;
  revealArticleBlock(element, viewer);
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "start" });
  const toolbar = viewer.querySelector(".mtg-instant-view-actions");
  if (toolbar) {
    const covered = toolbar.getBoundingClientRect().bottom - element.getBoundingClientRect().top;
    if (covered > 0) viewer.scrollTop -= covered;
  }
  return true;
}

function revealArticleBlock(element: HTMLElement, viewer: HTMLDialogElement) {
  let parent = element.parentElement?.closest("details");
  while (parent && viewer.contains(parent)) {
    parent.open = true;
    parent = parent.parentElement?.closest("details");
  }
}

function ArticleStaticEmbed({ html }: { html: string }) {
  const { t: tr } = useTelegramLocale();
  const [shown, setShown] = useState(false);
  return <>
    <button type="button" className="mtg-action" aria-expanded={shown} onClick={() => setShown((value) => !value)}>
      {shown ? tr("Hide embedded preview") : tr("Show embedded preview")}
    </button>
    {shown && <StaticTelegramMarkup html={html} className="mtg-instant-view-static-embed" />}
  </>;
}

function ArticleWebEmbed({ source, dimensions, fullWidth, allowScrolling }: {
  source: URL;
  dimensions?: { width: number; height: number };
  fullWidth?: true;
  allowScrolling?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [shown, setShown] = useState(false);
  const [resizedHeight, setResizedHeight] = useState<number>();
  const frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    if (!shown) return;
    function resize(event: MessageEvent) {
      const sender = frame.current?.contentWindow;
      if (!sender || event.source !== sender || event.origin !== "null" ||
        typeof event.data !== "string" || event.data.length > 512) return;
      const message = miniAppFrameEvent(event.data);
      if (message?.type !== "resize_frame" || !message.payload || typeof message.payload !== "object" ||
        !("height" in message.payload)) return;
      const height = message.payload.height;
      const pixels = typeof height === "number" ? height
        : typeof height === "string" && /^\d+(?:\.\d+)?(?:px)?$/.test(height.trim()) ? Number.parseFloat(height) : 0;
      // The embed controls its own box height within the article's layout.
      if (Number.isFinite(pixels) && pixels > 0) setResizedHeight(Math.max(1, Math.min(4096, Math.round(pixels))));
    }
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [shown]);
  const { width, height } = dimensions ?? { width: 640, height: 360 };
  return <>
    <div className="mtg-instant-view-actions">
      <button type="button" className="mtg-action" aria-expanded={shown} onClick={() => {
        setResizedHeight(undefined);
        setShown(!shown);
      }}>
        {shown ? tr("Hide embedded content") : <>{tr("Load content from ")}<bdi>{source.host}</bdi></>}
      </button>
      <a href={source.href} target="_blank" rel="noopener noreferrer">{tr("Open embedded content")}</a>
    </div>
    {shown && <iframe ref={frame} className="mtg-instant-view-embed" src={source.href} title={tr("Embedded content from {0}", [source.host])}
      style={{ width: fullWidth ? "100%" : width, height: resizedHeight,
        aspectRatio: resizedHeight === undefined ? `${width} / ${height}` : undefined }}
      scrolling={allowScrolling === undefined ? undefined : allowScrolling ? "auto" : "no"}
      sandbox="allow-scripts" referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'" />}
  </>;
}

export function MediaSlideshow({ count, rtl, index: selected, select, renderSlide, label = "Article" }: {
  count: number; rtl: boolean; index: number; label?: string; select: (index: number) => void; renderSlide: (index: number) => ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  if (!count) return null;
  const index = Math.min(count - 1, Math.max(0, selected));
  const move = (step: number) => select(Math.min(count - 1, Math.max(0, index + step)));
  return <>
    <ul className="mtg-instant-view-slideshow" aria-label={tr("{0} slides", [label])}>
      <li key={index}>{renderSlide(index)}</li>
    </ul>
    {count > 1 && <div className="mtg-instant-view-slide-controls" role="group" aria-label={tr("{0} slide navigation", [label])} onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") select(0);
      else if (event.key === "End") select(count - 1);
      else move((event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1));
    }}>
      <button type="button" className="mtg-action" aria-disabled={index === 0} onClick={() => move(-1)}>{tr("Previous slide")}</button>
      <span role="status">{index + 1} / {count}</span>
      <button type="button" className="mtg-action" aria-disabled={index === count - 1} onClick={() => move(1)}>{tr("Next slide")}</button>
    </div>}
  </>;
}

export function InstantViewDialog({ url: initialUrl, load, close: onClose, continuityScope, resumed }: {
  url: string; load: LoadInstantView; close: () => void; continuityScope?: string; resumed?: ArticleContinuation;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const regionId = useId();
  const searchTag = useContext(InstantViewTagSearch);
  const share = useContext(InstantViewShare);
  const openMention = useContext(InstantViewMentionOpen);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastScrollTop = useRef(0);
  const closing = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const articleBody = useRef<HTMLElement>(null);
  const changesSection = useRef<HTMLElement>(null);
  const pendingChangesScroll = useRef<number | undefined>(undefined);
  const pendingSectionReturn = useRef<{ pageId: number; visit: ArticleSectionVisit } | undefined>(undefined);
  const zoomAnchor = useRef<{ block: Element; fraction: number } | undefined>(undefined);
  const [scale, setScale] = useState<ArticleScale>(resumed?.scale ?? 100);
  const openTelegram = useContext(OpenTelegramMessageLink);
  const saveDocument = useContext(InstantViewDocumentSaver);
  const loadPhoto = useContext(InstantViewPhotoLoader);
  const loadPlayback = useContext(InstantViewPlaybackLoader);
  const nextPageId = useRef(resumed ? Math.max(...resumed.pages.map(({ id }) => id)) + 1 : 1);
  const [pages, setPages] = useState<ArticlePage[]>(resumed?.pages ?? [{ id: 0, url: initialUrl }]);
  const continuation = useRef({ pages, scale });
  function close() {
    closing.current = true;
    onClose();
  }
  useLayoutEffect(() => { continuation.current = { pages, scale }; }, [pages, scale]);
  useLayoutEffect(() => {
    clearArticleHandoff(resumed);
    const viewer = dialog.current;
    if (!continuityScope || !viewer) return;
    const path = window.location.pathname;
    let settledWidth = window.innerWidth;
    let settleTimer: number | undefined;
    const settleWidth = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => { settledWidth = window.innerWidth; }, 300);
    };
    window.addEventListener("resize", settleWidth);
    return () => {
      window.removeEventListener("resize", settleWidth);
      window.clearTimeout(settleTimer);
      if (closing.current || !viewer.open || settledWidth === window.innerWidth || window.location.pathname !== path) return;
      const { pages, scale } = continuation.current;
      const page = pages.at(-1)!;
      handOffArticle(continuityScope, { pages: [...pages.slice(0, -1), {
        ...page, top: lastScrollTop.current, detailsState: articleDetailsState(viewer),
      }], scale });
    };
  }, [continuityScope, resumed]);
  const page = pages[pages.length - 1]!;
  const { article } = page;
  const directLink = telegramInstantViewLink(page.url);
  const url = directLink?.lookup ?? page.url;
  const source = directLink?.source ?? url;
  const showChanges = page.changesReturnTop !== undefined && !!article?.changes;
  const [pendingSection, setPendingSection] = useState<{ url: string; path: string }>();
  const selectSlide = useCallback((path: string, index: number) => {
    setPages((previous) => {
      const current = previous.at(-1);
      if (!current || (current.slides?.[path] ?? 0) === index) return previous;
      return [...previous.slice(0, -1), { ...current, slides: { ...current.slides, [path]: index } }];
    });
  }, []);
  const navigateSection = useCallback((viewer: HTMLDialogElement, section: ArticleSection) => {
    if (focusArticleSection(viewer, section.path)) return true;
    if (!section.slide) return false;
    const { gallery, index } = section.slide;
    selectSlide(gallery, index);
    setPendingSection({ url, path: section.path });
    return true;
  }, [url, selectSlide]);
  useLayoutEffect(() => {
    if (!pendingSection) return;
    if (dialog.current && pendingSection.url === url) focusArticleSection(dialog.current, pendingSection.path);
    setPendingSection(undefined);
  }, [pendingSection, url]);
  useLayoutEffect(() => {
    const viewer = dialog.current;
    if (viewer && !viewer.open) viewer.showModal();
  }, []);
  useEffect(() => {
    if (page.article !== undefined) return;
    let active = true;
    const finish = (article: InstantViewArticle | null) => {
      if (active) setPages((previous) => previous.at(-1) === page
        ? [...previous.slice(0, -1), { ...page, article }]
        : previous);
    };
    void load(url).then(finish, () => finish(null));
    return () => { active = false; };
  }, [page, load, url]);
  const { top, returnLink, detailsState, readingAnchor } = page;
  useLayoutEffect(() => {
    const viewer = dialog.current;
    if (!viewer) return;
    if (detailsState) restoreArticleDetails(viewer, detailsState);
    const link = returnLink && findReturnLink(viewer, returnLink);
    if (link) revealArticleBlock(link, viewer);
    viewer.scrollTop = top ?? 0;
    if (article && !article.incompleteSource && readingAnchor && articleBody.current && toolbar.current) {
      restoreArticleReadingAnchor(articleBody.current, viewer, toolbar.current, readingAnchor);
    }
    lastScrollTop.current = viewer.scrollTop;
    const hashIndex = source.indexOf("#");
    const section = top === undefined && article && hashIndex >= 0
      ? findArticleSection(article, source.slice(hashIndex + 1)) : undefined;
    if (!section || !navigateSection(viewer, section)) (link ?? closeButton.current)?.focus({ preventScroll: true });
  }, [url, source, article, top, returnLink, detailsState, readingAnchor, pages.length, navigateSection]);
  useLayoutEffect(() => {
    const viewer = dialog.current;
    const pending = pendingSectionReturn.current;
    if (!viewer || pending?.pageId !== page.id) return;
    pendingSectionReturn.current = undefined;
    restoreArticleDetails(viewer, pending.visit.details);
    const link = findReturnLink(viewer, pending.visit.link);
    if (link) revealArticleBlock(link, viewer);
    (link ?? closeButton.current)?.focus({ preventScroll: true });
    viewer.scrollTop = pending.visit.top;
  }, [page.id, page.sectionHistory]);
  useLayoutEffect(() => {
    const viewer = dialog.current;
    const nextTop = pendingChangesScroll.current;
    pendingChangesScroll.current = undefined;
    if (!viewer || nextTop === undefined) return;
    viewer.scrollTop = nextTop;
    if (showChanges) changesSection.current?.focus({ preventScroll: true });
  }, [showChanges]);
  function toggleChanges() {
    const currentTop = dialog.current?.scrollTop ?? 0;
    pendingChangesScroll.current = page.changesReturnTop ?? 0;
    setPages((previous) => previous.map((entry) => entry.id === page.id
      ? { ...entry, changesReturnTop: showChanges ? undefined : currentTop }
      : entry));
  }
  function changeScale(next: ArticleScale) {
    if (next === scale) return;
    const readingLine = toolbar.current?.getBoundingClientRect().bottom;
    if (readingLine !== undefined && articleBody.current && dialog.current?.scrollTop) {
      const block = Array.from(articleBody.current.children).find((child) => {
        const bounds = child.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > readingLine;
      });
      if (block) {
        const bounds = block.getBoundingClientRect();
        zoomAnchor.current = { block, fraction: (readingLine - bounds.top) / bounds.height };
      }
    }
    setScale(next);
  }
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = undefined;
    const viewer = dialog.current;
    if (!anchor?.block.isConnected || !viewer || !toolbar.current) return;
    const bounds = anchor.block.getBoundingClientRect();
    const readingLine = toolbar.current.getBoundingClientRect().bottom;
    viewer.scrollTop += bounds.top + bounds.height * anchor.fraction - readingLine;
  }, [scale]);
  function zoomWithKeyboard(event: KeyboardEvent<HTMLDialogElement>) {
    if (!article || event.defaultPrevented || event.altKey || event.ctrlKey === event.metaKey
      || (event.target instanceof Element && event.target.closest("dialog") !== event.currentTarget)) return;
    const direction = event.key === "+" || event.key === "=" ? 1 : event.key === "-" ? -1 : 0;
    if (!direction && event.key !== "0") return;
    event.preventDefault();
    event.stopPropagation();
    changeScale(direction ? articleScales[articleScales.indexOf(scale) + direction] ?? scale : 100);
  }
  async function retryArticle() {
    if (!article?.incompleteSource || page.retry === "loading") return;
    const update = (apply: (entry: ArticlePage) => ArticlePage) => {
      setPages((previous) => previous.map((entry) => entry.id === page.id ? apply(entry) : entry));
    };
    update((entry) => ({ ...entry, retry: "loading" }));
    let full: InstantViewArticle | null;
    try {
      full = await load(url);
    } catch {
      full = null;
    }
    if (!full || full.incompleteSource) {
      update((entry) => ({ ...entry, retry: "failed" }));
      return;
    }
    const viewer = articleBody.current?.dataset.articlePage === String(page.id) ? dialog.current : null;
    const readingPosition = viewer ? { top: viewer.scrollTop, detailsState: articleDetailsState(viewer),
      readingAnchor: captureArticleReadingAnchor(articleBody.current, viewer, toolbar.current) } : undefined;
    update((entry) => ({ ...entry, ...readingPosition, article: full, retry: undefined, slides: undefined, sectionHistory: undefined }));
  }
  function openArticle(event: MouseEvent<HTMLAnchorElement>, target: URL) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pages.length >= 20) return;
    const viewer = dialog.current;
    if (!viewer) return;
    event.preventDefault();
    const links = articleNavigationLinks(viewer);
    const returnLink = { index: links.indexOf(event.currentTarget), href: event.currentTarget.href };
    const detailsState = articleDetailsState(viewer);
    const top = viewer.scrollTop;
    const readingAnchor = article?.incompleteSource ? captureArticleReadingAnchor(articleBody.current, viewer, toolbar.current) : undefined;
    const id = nextPageId.current++;
    setPages((previous) => {
      const current = previous.at(-1);
      return current?.id === page.id
        ? [...previous.slice(0, -1), { ...current, top, returnLink, detailsState, readingAnchor }, { id, url: target.href }]
        : previous;
    });
  }

  function returnToSection() {
    const visit = page.sectionHistory?.at(-1);
    if (!visit) return;
    pendingSectionReturn.current = { pageId: page.id, visit };
    setPages((previous) => previous.map((entry) => entry.id === page.id
      ? { ...entry, slides: visit.slides, sectionHistory: entry.sectionHistory?.slice(0, -1) } : entry));
  }

  function renderArticleLink(target: URL, label: ReactNode, link?: MessageLink) {
    const hashIndex = target.href.indexOf("#");
    const sameArticle = target.href.split("#")[0] === source.split("#")[0];
    if (!sameArticle && (link?.instantView || telegramInstantViewLink(target.href))) return <a href={target.href} target="_blank" rel="noopener noreferrer"
      data-article-navigation onClick={(event) => openArticle(event, target)}>{label}</a>;
    if (hashIndex < 0 || !sameArticle || !article) {
      const telegramUrl = canonicalTelegramContentLink(target.href);
      if (telegramUrl && followArticleTelegramLink) {
        return <TelegramMessageLink url={telegramUrl} follow={followArticleTelegramLink}>{label}</TelegramMessageLink>;
      }
      return;
    }
    return <a href={target.href} target="_blank" rel="noopener noreferrer" data-article-navigation onClick={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const viewer = dialog.current;
      if (!viewer) return;
      const destination = findArticleSection(article, target.href.slice(hashIndex + 1));
      if (!destination) return;
      const visit: ArticleSectionVisit = {
        top: viewer.scrollTop,
        link: { index: articleNavigationLinks(viewer).indexOf(event.currentTarget), href: event.currentTarget.href },
        details: articleDetailsState(viewer),
        slides: page.slides,
      };
      if (!navigateSection(viewer, destination)) return;
      event.preventDefault();
      setPages((previous) => previous.map((entry) => entry.id === page.id
        ? { ...entry, sectionHistory: [...(entry.sectionHistory ?? []).slice(-19), visit] } : entry));
    }}>{label}</a>;
  }
  const loadAvatar = useCallback<AvatarLoader>((source, fileId) => loadPhoto!(source, fileId), [loadPhoto]);
  const photoLoader = useCallback((source: string, id: string, size?: PhotoSize) =>
    loadPhoto!(source, Number(id.split(":", 1)[0]), size), [loadPhoto]);
  const savePhoto = useCallback((source: string, id: string) =>
    saveDocument?.(source, Number(id.split(":", 1)[0])) ?? Promise.resolve(false), [saveDocument]);
  function renderCredit(credit: ArticleInline | undefined) {
    return credit && <small className="mtg-instant-view-credit"><ArticleText {...credit} renderLink={renderArticleLink} /></small>;
  }
  function renderMedia(block: ArticleMedia, gallery?: { album: AlbumPhoto[]; index: number }, embeddedPoster = false) {
    if (block.kind === "map") return <ArticleMap url={url} point={block.point} />;
    if (block.kind === "video" || block.kind === "audio") {
      const media = block.kind === "video" ? block.video : block.audio;
      const audio = block.kind === "audio" ? block.audio : undefined;
      const track = audio?.audioTrack;
      const audioMetadata = track && { title: track.title ?? audio?.document?.name ?? "Audio", artist: track.artist };
      const player = loadPlayback ? <ArticlePlayer key={JSON.stringify([url, media.fileId, "posterFileId" in media ? media.posterFileId : null])}
        url={url} {...media} audioMetadata={audioMetadata} load={loadPlayback} /> : undefined;
      const unavailable = <p>{tr("Playback unavailable.")}</p>;
      const controls = saveDocument && media.document?.downloadable && (block.kind === "audio" || !block.video.spoiler)
        ? <>{!player && unavailable}<DocumentButton key={media.fileId} document={media.document} player={player}
            save={() => saveDocument(url, media.fileId)} /></>
        : player ?? unavailable;
      const cover = renderAvatar(track?.title ?? track?.artist ?? "", audio?.coverFileId);
      if (!track && !cover) return controls;
      return <>
        <div className="mtg-instant-view-audio-track">
          {cover}
          {track && <div>
            {track.title && <strong><bdi>{track.title}</bdi></strong>}
            {track.artist && <small><bdi>{track.artist}</bdi></small>}
          </div>}
        </div>
        {controls}
      </>;
    }
    if (block.kind === "document") return <DocumentButton document={block.document} save={saveDocument && block.document.downloadable
      ? () => saveDocument(url, block.fileId) : undefined} />;
    const { text, links, styles } = block;
    const target = block.url && webLink(block.url);
    const photo = block.kind === "photo" ? block.photo : undefined;
    const renderPhotoLink = target ? (image?: ReactNode) => {
      const label = image ?? tr("Open photo link");
      return renderArticleLink(target, label) ??
        <a href={target.href} target="_blank" rel="noopener noreferrer">{label}</a>;
    } : undefined;
    if (photo && loadPhoto) return <PhotoPreview key={articlePhotoId(photo.fileId, gallery?.index)} chatId={url}
      messageId={articlePhotoId(photo.fileId, gallery?.index)} dimensions={photo.dimensions}
      articleLayout={{ width: photo.fullWidth ?? photo.dimensions.width, scale }}
      spoiler={photo.spoiler} caption={{ photoCaption: text, links, styles }} album={gallery?.album} load={photoLoader}
      canSave={!embeddedPoster && !photo.spoiler} save={saveDocument ? savePhoto : undefined} renderPhotoLink={renderPhotoLink} />;
    return <><p>{photo ? tr("Photo unavailable.") : tr("Media unavailable")}</p>{renderPhotoLink?.()}</>;
  }
  const followArticleTelegramLink: FollowTelegramMessageLink | undefined = openTelegram && (async (target, signal) => {
    const opened = await openTelegram(target, signal);
    if (opened && !signal.aborted) close();
    return opened;
  });
  function renderAvatar(name: string, fileId?: number) {
    if (!fileId || !loadPhoto) return null;
    const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
    return <Avatar chat={{ id: url, color: "#246dbd", initials, avatarFileId: fileId }} load={loadAvatar} />;
  }
  function renderBlock(block: InstantViewArticle["blocks"][number], path: string): ReactNode {
    if (block.kind === "anchor") return <div key={path} data-article-block={path} tabIndex={-1} />;
    const { kind, text, styles, links } = block;
    const content = <ArticleText {...block} renderLink={renderArticleLink} />;
    if (block.kind === "math") return <div key={path} className="mtg-instant-view-formula" data-article-block={path} tabIndex={-1}>
      <MathFormula expression={text} displayMode />
    </div>;
    if (block.kind === "byline") {
      const date = block.publishedAt === undefined ? undefined : new Date(block.publishedAt * 1000);
      return <p key={path} data-article-block={path} tabIndex={-1}>
        {text && <bdi>{content}</bdi>}
        {text && date && " · "}
        {date && <time dateTime={date.toISOString()}>{date.toLocaleDateString(uiLocale)}</time>}
      </p>;
    }
    if (block.kind === "details") return <details key={path} data-article-block={path} tabIndex={-1} open={block.open}>
      <summary>{text ? content : tr("Details")}</summary>
      {block.blocks.map((child, index) => renderBlock(child, `${path}.${index}`))}
    </details>;
    if (block.kind === "embeddedPost") {
      const source = block.source ? webLink(block.source) : undefined;
      const telegram = source ? canonicalTelegramMessageLink(source.href) : undefined;
      const date = block.publishedAt === undefined ? undefined : new Date(block.publishedAt * 1000);
      return <figure key={path} data-article-block={path} tabIndex={-1}>
        {(block.author || date || source || block.avatarFileId) && <header className="mtg-instant-view-attribution">
          {renderAvatar(block.author, block.avatarFileId)}
          {block.author && <strong><bdi>{block.author}</bdi></strong>}
          {date && <> <time dateTime={date.toISOString()}>{date.toLocaleDateString(uiLocale)}</time></>}
          {source && <> {telegram && followArticleTelegramLink
            ? <TelegramMessageLink url={telegram} follow={followArticleTelegramLink}>{tr("Open original post")}</TelegramMessageLink>
            : <a href={source.href} target="_blank" rel="noopener noreferrer">{tr("Open original post")}</a>}</>}
        </header>}
        {block.blocks.map((child, index) => renderBlock(child, `${path}.${index}`))}
        {(text || block.credit) && <figcaption>{content}{renderCredit(block.credit)}</figcaption>}
      </figure>;
    }
    if (block.kind === "webEmbed") {
      const source = block.source && webLink(block.source);
      return <figure key={path} data-article-block={path} tabIndex={-1}>
        {block.photo && renderMedia({ kind: "photo", photo: block.photo, text, styles, links }, undefined, true)}
        {source && <ArticleWebEmbed key={source.href} source={source} dimensions={block.dimensions}
          fullWidth={block.fullWidth} allowScrolling={block.allowScrolling} />}
        {block.staticHtml && <ArticleStaticEmbed html={block.staticHtml} />}
        {(text || block.credit) && <figcaption>{content}{renderCredit(block.credit)}</figcaption>}
      </figure>;
    }
    if (block.kind === "chatLink") {
      const target = canonicalTelegramPublicChatLink(block.url);
      if (!target) return null;
      const handle = "@" + new URL(target).pathname.slice(1);
      const label = <><bdi>{text || handle}</bdi>{text && <> <bdi>{handle}</bdi></>}</>;
      return <p key={path} data-article-block={path} tabIndex={-1} className="mtg-instant-view-attribution">
        {renderAvatar(text || handle, block.avatarFileId)}
        {followArticleTelegramLink ? <TelegramMessageLink url={target} follow={followArticleTelegramLink}>{label}</TelegramMessageLink>
          : <a href={target} target="_blank" rel="noopener noreferrer">{label}</a>}
        <ArticleJoin key={`${url}:${target}`} url={url} target={target} />
      </p>;
    }
    if (block.kind === "buttons") return <div key={path} data-article-block={path} tabIndex={-1}
      className="mtg-instant-view-button-row" data-align={block.align}>
      <OpenTelegramMessageLink.Provider value={followArticleTelegramLink}>
        {block.buttons.map((button, index) => <ArticleAction key={index} button={button} renderLink={renderArticleLink} />)}
      </OpenTelegramMessageLink.Provider>
    </div>;
    if (block.kind === "divider") return <hr key={path} data-article-block={path} tabIndex={-1} />;
    if (block.kind === "related") return <section key={path} data-article-block={path} tabIndex={-1}>
      <h2>{text ? content : tr("Related articles")}</h2>
      <ul>{block.articles.map(({ url, title, description, author, publishedAt, previewFileId }, articleIndex) => {
        const target = webLink(url);
        if (!target) return null;
        const date = publishedAt === undefined ? undefined : new Date(publishedAt * 1000);
        return <li key={articleIndex}>
          <a href={target.href} target="_blank" rel="noopener noreferrer" className="mtg-instant-view-attribution"
            data-article-navigation onClick={(event) => openArticle(event, target)}>{renderAvatar(title || target.hostname, previewFileId)}<bdi>{title || target.hostname}</bdi></a>
          {description && <div><bdi>{description}</bdi></div>}
          {(author || date) && <small>
            {author && <bdi>{author}</bdi>}{author && date && " · "}
            {date && <time dateTime={date.toISOString()}>{date.toLocaleDateString(uiLocale)}</time>}
          </small>}
        </li>;
      })}</ul>
    </section>;
    if (block.kind === "richQuote") return <blockquote key={path} data-article-block={path} tabIndex={-1} className="mtg-instant-view-quote">
      {block.blocks.map((child, index) => renderBlock(child, path + "." + index))}
      {block.credit && <footer data-article-block={path + ".credit"} tabIndex={-1}>
        <ArticleText {...block.credit} renderLink={renderArticleLink} />
      </footer>}
    </blockquote>;
    if (block.kind === "quoteGroup") {
      const quote = <blockquote className="mtg-instant-view-quote" data-pull={block.pull}>
        {block.paragraphs.map((paragraph, paragraphIndex) => {
          const Tag = paragraph.kind === "code" ? "pre" : "p";
          return <Tag key={paragraphIndex} data-article-block={path + ".quote." + paragraphIndex} tabIndex={-1}>
            <ArticleText {...paragraph} renderLink={renderArticleLink} />
          </Tag>;
        })}
        {block.credit && <footer data-article-block={path + ".credit"} tabIndex={-1}>
          <ArticleText {...block.credit} renderLink={renderArticleLink} />
        </footer>}
      </blockquote>;
      return block.expandable
        ? <details key={path} data-article-block={path} tabIndex={-1}><summary>{tr("Show quote")}</summary>{quote}</details>
        : <div key={path} data-article-block={path} tabIndex={-1}>{quote}</div>;
    }
    if (block.kind === "list") return <div key={path} data-article-block={path} tabIndex={-1}>
      <ArticleList items={block.items} renderItem={(blocks, itemIndex) =>
        blocks.map((child, index) => renderBlock(child, path + "." + itemIndex + "." + index))} />
    </div>;
    if (block.kind === "table") return <div key={path}>
      <CopyTextAction button={{ label: "Copy table", text: () => tabSeparatedTableText(block.rows) }} />
      <div data-article-block={path} tabIndex={0}
        role="region" aria-labelledby={text ? `${regionId}-table-${path}` : undefined}
        aria-label={text ? undefined : tr("Article table")} className="mtg-instant-view-table-scroll">
        <table className="mtg-instant-view-table" data-bordered={block.bordered} data-striped={block.striped} data-compact={block.compact}>
          {text && <caption id={`${regionId}-table-${path}`}>{content}</caption>}
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
            const Cell = cell.header ? "th" : "td";
            return <Cell key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}
              {...(!cell.invisible && cell.anchors?.length && {
                "data-article-block": path + ".cell." + rowIndex + "." + cellIndex, tabIndex: -1,
              })}
              aria-hidden={cell.invisible}
              style={{ textAlign: cell.align, verticalAlign: cell.verticalAlign, visibility: cell.invisible ? "hidden" : undefined }}>
              <ArticleText {...cell} renderLink={renderArticleLink} />
            </Cell>;
          })}</tr>)}</tbody>
        </table>
      </div>
    </div>;
    if (block.kind === "photo" || block.kind === "video" || block.kind === "audio" || block.kind === "document" || block.kind === "missingMedia" || block.kind === "map") return <figure key={path} data-article-block={path} tabIndex={-1}>
      {renderMedia(block)}
      {(text || block.credit) && <figcaption>{content}{renderCredit(block.credit)}</figcaption>}
    </figure>;
    if (block.kind === "collage" || block.kind === "slideshow") {
      const album = block.media.flatMap((item, index) => item.kind === "photo" ? [{
        id: articlePhotoId(item.photo.fileId, index), spoiler: item.photo.spoiler, canSave: !item.photo.spoiler,
        caption: { photoCaption: item.text, styles: item.styles, links: item.links },
      }] : []);
      const renderSlide = (index: number) => {
        const item = block.media[index]!;
        return <div data-article-block={path + ".media." + index} tabIndex={-1}>
          {renderMedia(item, { album, index })}
          {item.text && <div><ArticleText {...item} renderLink={renderArticleLink} /></div>}
          {renderCredit(item.credit)}
        </div>;
      };
      return <figure key={path} data-article-block={path} tabIndex={-1}>
        {block.kind === "slideshow"
          ? <MediaSlideshow count={block.media.length} rtl={article?.rtl === true} index={page.slides?.[path] ?? 0}
            select={(index) => selectSlide(path, index)}
            renderSlide={renderSlide} />
          : <ul className="mtg-instant-view-collage" aria-label={tr("Article collage")}>
            {block.media.map((_, index) => <li key={index}>{renderSlide(index)}</li>)}
          </ul>}
        {(text || block.credit) && <figcaption>{content}{renderCredit(block.credit)}</figcaption>}
      </figure>;
    }
    if (block.kind === "code") return <ArticleCode key={path} block={block} path={path} renderLink={renderArticleLink} />;
    const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
    const Tag = kind === "title" ? "h1" : kind === "heading" ? headings[(block.level ?? 2) - 1] ?? "h2"
      : kind === "quote" ? "blockquote" : kind === "footer" ? "footer" : "p";
    return <Tag key={path} data-article-block={path} data-article-kind={kind} tabIndex={-1}>
      {content}
    </Tag>;
  }
  const feedbackUrl = article?.feedbackUrl && canonicalTelegramBotStartLink(article.feedbackUrl);
  const shareUrl = article && share ? webLink(page.url)?.href : undefined;
  const changesId = `${regionId}-changes`;
  return <dialog ref={dialog} className="mtg-instant-view" aria-label={tr("Instant View")} onClose={close} onKeyDown={zoomWithKeyboard}
    onScroll={(event) => { lastScrollTop.current = event.currentTarget.scrollTop; }}>
    <div ref={toolbar} className="mtg-instant-view-actions">
      <button ref={closeButton} type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close Instant View")}</button>
      {!!page.sectionHistory?.length && <button type="button" className="mtg-action" onClick={returnToSection}>{tr("Back to previous section")}</button>}
      {pages.length > 1 && <button type="button" className="mtg-action"
        onClick={() => setPages((previous) => previous.slice(0, -1))}>{tr("Back to article")}</button>}
      <a href={source} target="_blank" rel="noopener noreferrer">{tr("Open original")}</a>
      {share && shareUrl && shareUrl.length <= 4096 && <button type="button" className="mtg-action" onClick={() => {
        close();
        share(shareUrl);
      }}>{tr("Share article")}</button>}
      {article?.changes && <button type="button" className="mtg-action" aria-expanded={showChanges}
        aria-controls={changesId} onClick={(event) => {
          if (showChanges) event.currentTarget.focus({ preventScroll: true });
          toggleChanges();
        }}>
        {showChanges ? tr("Hide changes") : tr("Show changes")}
      </button>}
      {article && <label className="mtg-instant-view-scale">{tr("Zoom")}<select value={scale} aria-keyshortcuts="Control+= Control+- Control+0 Meta+= Meta+- Meta+0"
          onChange={(event) => {
            const selected = articleScales.find((value) => value === Number(event.currentTarget.value));
            if (selected !== undefined) changeScale(selected);
          }}>
          {articleScales.map((value) => <option key={value} value={value}>{value}%</option>)}
        </select>
      </label>}
    </div>
    {article === undefined && <p role="status">{tr("Loading article…")}</p>}
    {article === null && <p role="status">{tr("Instant View is unavailable for this link.")}</p>}
    {article && <article ref={articleBody} key={url} data-article-page={page.id} dir={article.rtl ? "rtl" : "ltr"} style={{ zoom: scale / 100 }}>
      {article.incompleteSource ? <div>
        <p role="status">{page.retry === "loading" ? tr("Loading full article…") : page.retry === "failed"
          ? tr("Could not load the full article. The excerpt is still available.") : tr("Telegram provided an excerpt of this article.")}</p>
        <button type="button" className="mtg-action" disabled={page.retry === "loading"} onClick={() => void retryArticle()}>{tr("Retry full article")}</button>
      </div> : article.partial && <p role="status">{tr("Some content is available on the original page.")}</p>}
      {article.changes && <section ref={changesSection} id={changesId} aria-label={tr("Article changes")} tabIndex={-1} hidden={!showChanges}>
        {showChanges && <ul className="mtg-instant-view-changes">
          {article.changes.map(({ original, current }, index) => <li key={index}>
            {original && <div>{tr("Before ")}<del dir="auto">{original}</del></div>}
            {current && <div>{tr("After ")}<ins dir="auto">{current}</ins></div>}
          </li>)}
        </ul>}
      </section>}
      <InstantViewTagSearch.Provider value={searchTag && ((tag) => { searchTag(tag); close(); })}>
      <InstantViewMentionOpen.Provider value={openMention && (async (source, userId, signal) => {
        const opened = await openMention(source, userId, signal);
        if (opened && !signal.aborted) close();
        return opened;
      })}>
      <ArticleUrl.Provider value={url}><ArticleClockProvider>
        {article.blocks.map((block, index) => renderBlock(block, String(index)))}
      </ArticleClockProvider></ArticleUrl.Provider>
      </InstantViewMentionOpen.Provider>
      </InstantViewTagSearch.Provider>
      {feedbackUrl && <footer>
        {followArticleTelegramLink ? <TelegramMessageLink url={feedbackUrl} follow={followArticleTelegramLink}>{tr("Give Instant View feedback")}</TelegramMessageLink>
          : <a href={feedbackUrl} target="_blank" rel="noopener noreferrer">{tr("Give Instant View feedback")}</a>}
      </footer>}
    </article>}
  </dialog>;
}
