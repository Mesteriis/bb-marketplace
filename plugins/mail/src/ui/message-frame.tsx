// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/components/email/EmailRenderer.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// One message body. HTML goes into a sandboxed iframe that can never run
// scripts; the parent sizes it to its content and handles its link clicks.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageBody } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { quoteRanges } from "../core/quotes.ts";
import { declaresDarkSupport, htmlToPlainText, isAllowedLinkUrl, sanitizeEmailHtml } from "./sanitize.ts";
import type { CodeRenderers } from "./bb-ports.ts";
import { BodyParts, HtmlCodeBlocks } from "./code-blocks.tsx";
import type { LinkHover } from "./link-status.tsx";
import { isTypingTarget } from "./shortcuts.ts";

/** Slice 3h: the fold of quoted text, in a plain body and under an HTML frame. */
export const SHOW_QUOTES_TEXT = "\u00b7\u00b7\u00b7 Show quoted text";
export const HIDE_QUOTES_TEXT = "Hide quoted text";

const INITIAL_HEIGHT = 120;
const NO_RENDERERS: CodeRenderers = {};

export interface MessageFrameProps {
  body: MessageBody;
  /** Accessible name of the frame, e.g. "Message from Ada". */
  title: string;
  /** Called with an http(s) or mailto URL the owner clicked, and the link's visible text (slice 3i). */
  onOpenLink: (url: string, text?: string | null) => void;
  /** Slice 3i: the link under the pointer or focus, for the status line; null when none. */
  onLinkHover?: (link: LinkHover | null) => void;
  /** Slice 3i: the cleanLinks setting (default on): hrefs are cleaned when sanitized. */
  cleanLinks?: boolean;
  /**
   * Slice 3i: why this sender's images are not loaded automatically (part A
   * resolution 5), or null. Set, the bar says so and offers no Always show.
   */
  imagesHeld?: string | null;
  /**
   * Render https: images: the sender is allowed, or the owner chose Show
   * images for this message. `body.remoteImagesAllowed` counts too.
   */
  remoteImages: boolean;
  /** Show this message's remote images, this time only. */
  onShowImages: () => void;
  /** The sender's address for "Always show from …"; null hides that button. */
  senderAddress: string | null;
  /** Allow remote images from the sender from now on. */
  onAlwaysShowImages: () => void;
  /** The sender is on the always-show list (server or this page session). */
  senderTrusted: boolean;
  /** Take the sender off that list. */
  onStopImages: () => void;
  /** Slice 3g: BB's code renderers for code in the body; absent: the <pre> fallback. */
  renderers?: CodeRenderers;
  /** Slice 3h: Show plain text renders the text part (or text from the HTML). */
  view?: "original" | "plain";
  /** Slice 3h: BB is dark and the mail's colors are adapted (darkMail adapt, not Original colors). */
  dark?: boolean;
  /** Slice 3h: quoted text shows (the owner's toggle, Expand all, or hideQuotes off). */
  quotesShown?: boolean;
  onToggleQuotes?: () => void;
}

/**
 * Plain text with quoted ranges folded behind one button each (slice 3h).
 * The ranges come from core/quotes.ts.
 */
export function PlainBody({
  text,
  renderers,
  quotesShown,
  onToggleQuotes,
}: {
  text: string;
  renderers: CodeRenderers;
  quotesShown: boolean;
  onToggleQuotes?: () => void;
}) {
  const ranges = useMemo(() => quoteRanges(text), [text]);
  if (ranges.length === 0 || onToggleQuotes === undefined) return <BodyParts text={text} renderers={renderers} />;
  const parts: { quoted: boolean; text: string }[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) parts.push({ quoted: false, text: text.slice(at, range.start) });
    parts.push({ quoted: true, text: text.slice(range.start, range.end) });
    at = range.end;
  }
  if (at < text.length) parts.push({ quoted: false, text: text.slice(at) });
  return (
    <div className="flex flex-col gap-1">
      {parts.map((part, index) =>
        !part.quoted ? (
          part.text.trim() === "" ? null : <BodyParts key={index} text={part.text.replace(/\n+$/, "")} renderers={renderers} />
        ) : quotesShown ? (
          <div key={index} className="flex flex-col gap-1 border-l-2 border-border pl-2 text-muted-foreground">
            <BodyParts text={part.text.replace(/\n+$/, "")} renderers={renderers} />
            <QuoteToggle shown onToggle={onToggleQuotes} />
          </div>
        ) : (
          <QuoteToggle key={index} shown={false} onToggle={onToggleQuotes} />
        ),
      )}
    </div>
  );
}

function QuoteToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <div>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" aria-expanded={shown} onClick={onToggle}>
        {shown ? HIDE_QUOTES_TEXT : SHOW_QUOTES_TEXT}
      </Button>
    </div>
  );
}

/** Duck-typed: the click target lives in the frame's own realm. */
function closestAnchor(target: EventTarget | null): Element | null {
  const node = target as { closest?: (selector: string) => Element | null } | null;
  return typeof node?.closest === "function" ? node.closest("a, area") : null;
}

/**
 * Keys the frame keeps (part B resolution 8): Enter, Space and Tab activate a
 * link or move focus there, and the arrows, Page Up/Down, Home and End
 * scroll; forwarded, Enter would also open the list's cursor row.
 */
const FRAME_KEYS = new Set(["Enter", " ", "Spacebar", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * A copy of a key pressed in the frame, dispatched on the `<iframe>` with the
 * parent realm's KeyboardEvent so it bubbles to the page's own handler (and
 * to BB's, like any page key). Key fields only; nothing of the mail is read.
 * Returns false when the copy was prevented.
 */
export function forwardFrameKey(frame: HTMLIFrameElement, event: KeyboardEvent): boolean {
  if (event.isComposing || event.key === "Process" || event.keyCode === 229) return true;
  if (FRAME_KEYS.has(event.key) || isTypingTarget(event.target)) return true;
  const View = frame.ownerDocument.defaultView;
  if (View === null) return true;
  const copy = new View.KeyboardEvent("keydown", {
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    isComposing: event.isComposing,
    bubbles: true,
    cancelable: true,
  });
  return frame.dispatchEvent(copy);
}

/** Longest visible link text passed on; cleanLink reads at most 300 characters. */
const LINK_TEXT_MAX = 1_000;

/** An anchor's visible text, whitespace collapsed; null for none. */
function anchorText(anchor: Element): string | null {
  const text = (anchor.textContent ?? "").slice(0, LINK_TEXT_MAX * 4).replace(/\s+/g, " ").trim().slice(0, LINK_TEXT_MAX);
  return text === "" ? null : text;
}

/** What the status line needs about an anchor; null when it opens nothing. */
function hoverOf(anchor: Element | null): LinkHover | null {
  const href = anchor?.getAttribute("href") ?? null;
  if (anchor === null || href === null || !isAllowedLinkUrl(href)) return null;
  const removed = Number(anchor.getAttribute("data-mk-cleaned") ?? "0");
  return {
    href,
    text: anchorText(anchor),
    removed: Number.isFinite(removed) && removed > 0 ? removed : 0,
    unwrapped: anchor.hasAttribute("data-mk-unwrapped"),
  };
}

export function MessageFrame({
  body,
  title,
  onOpenLink,
  remoteImages,
  onShowImages,
  senderAddress,
  onAlwaysShowImages,
  senderTrusted,
  onStopImages,
  renderers = NO_RENDERERS,
  view = "original",
  dark = false,
  quotesShown = true,
  onToggleQuotes,
  onLinkHover,
  cleanLinks = true,
  imagesHeld = null,
}: MessageFrameProps) {
  const showRemote = remoteImages || body.remoteImagesAllowed;
  // Dark support is read from the raw HTML (the sanitizer drops meta); it is never rendered.
  const darkSupported = useMemo(() => (dark && body.html !== null ? declaresDarkSupport(body.html) : false), [body.html, dark]);
  const sanitized = useMemo(
    () =>
      body.html !== null
        ? sanitizeEmailHtml(body.html, { remoteImages: showRemote, cleanLinks, ...(dark ? { dark: true, darkSupported } : {}) })
        : null,
    [body.html, showRemote, dark, darkSupported, cleanLinks],
  );

  if (view === "plain") {
    const text = body.text !== null && body.text.trim() !== "" ? body.text : body.html !== null ? htmlToPlainText(sanitizeEmailHtml(body.html, { remoteImages: false, cleanLinks }).html, { cleanLinks }) : "";
    return text.trim() !== "" ? (
      <PlainBody text={text} renderers={renderers} quotesShown={quotesShown} {...(onToggleQuotes !== undefined ? { onToggleQuotes } : {})} />
    ) : (
      <p className="text-sm text-muted-foreground">This message has no text.</p>
    );
  }

  if (sanitized === null) {
    return body.text !== null && body.text.trim() !== "" ? (
      <PlainBody text={body.text} renderers={renderers} quotesShown={quotesShown} {...(onToggleQuotes !== undefined ? { onToggleQuotes } : {})} />
    ) : (
      <p className="text-sm text-muted-foreground">This message has no text.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!showRemote && (sanitized.blockedRemoteImages || sanitized.trackers > 0) ? (
        <ImagesBar
          blocked={sanitized.blockedRemoteImages}
          trackers={sanitized.trackers}
          held={imagesHeld}
          senderAddress={senderAddress}
          onShowImages={onShowImages}
          onAlwaysShowImages={onAlwaysShowImages}
        />
      ) : null}
      {showRemote && sanitized.trackers > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{`Images shown \u00b7 ${trackersText(sanitized.trackers)} blocked`}</p>
      ) : null}
      {senderTrusted && senderAddress !== null && imagesHeld === null ? (
        <div
          role="region"
          aria-label="Trusted sender"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">Images from {senderAddress} are always shown.</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onStopImages}>
            Stop showing
          </Button>
        </div>
      ) : null}
      <HtmlFrame
        srcDoc={sanitized.html}
        title={title}
        onOpenLink={onOpenLink}
        {...(onLinkHover !== undefined ? { onLinkHover } : {})}
        quotesShown={sanitized.quotes === 0 || onToggleQuotes === undefined || quotesShown}
      />
      {sanitized.quotes > 0 && onToggleQuotes !== undefined ? <QuoteToggle shown={quotesShown} onToggle={onToggleQuotes} /> : null}
      <HtmlCodeBlocks blocks={body.codeBlocks ?? []} renderers={renderers} />
      {body.htmlTruncated ? (
        <p className="text-xs text-muted-foreground">
          This message is very long; the end is not shown.
        </p>
      ) : null}
    </div>
  );
}

/** "1 tracker", "2 trackers". */
export function trackersText(count: number): string {
  return count === 1 ? "1 tracker" : `${count} trackers`;
}

function ImagesBar({
  blocked,
  trackers,
  held,
  senderAddress,
  onShowImages,
  onAlwaysShowImages,
}: {
  /** Show images would reveal something (trackers never count). */
  blocked: boolean;
  trackers: number;
  /** Slice 3i: why this sender's images wait, or null. */
  held: string | null;
  senderAddress: string | null;
  onShowImages: () => void;
  onAlwaysShowImages: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Remote images"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
    >
      <Icon name="EyeOff" className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {!blocked ? (
          <span>{`Remote images: this message has ${trackersText(trackers)}; they stay blocked.`}</span>
        ) : (
          <>
            <span>
              {held !== null
                ? `Images from this sender are not loaded automatically because ${held}.`
                : "Images are hidden to protect your privacy."}
            </span>
            {trackers > 0 ? <span>{` This message has ${trackersText(trackers)}; they stay blocked.`}</span> : null}
          </>
        )}
      </span>
      {blocked ? (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onShowImages}>
          Show images
        </Button>
      ) : null}
      {blocked && held === null && senderAddress !== null ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-full px-2 text-xs"
          onClick={onAlwaysShowImages}
        >
          <span className="truncate">Always show from {senderAddress}</span>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Shows or hides Mail's quote marks in a loaded frame (spec resolution 14):
 * an attribute on the frame's root, set through contentDocument, which
 * `allow-same-origin` permits; the frame runs no script.
 */
export function applyQuotesShown(frame: HTMLIFrameElement | null, shown: boolean): void {
  const root = frame?.contentDocument?.documentElement;
  if (root == null) return;
  if (shown) root.setAttribute("data-mk-quotes", "shown");
  else root.removeAttribute("data-mk-quotes");
}

function HtmlFrame({
  srcDoc,
  title,
  onOpenLink,
  onLinkHover,
  quotesShown = true,
}: {
  srcDoc: string;
  title: string;
  onOpenLink: (url: string, text?: string | null) => void;
  onLinkHover?: (link: LinkHover | null) => void;
  quotesShown?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const quotesRef = useRef(quotesShown);
  quotesRef.current = quotesShown;
  useEffect(() => {
    applyQuotesShown(frameRef.current, quotesShown);
  }, [quotesShown]);
  const openLinkRef = useRef(onOpenLink);
  const detachRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);

  const hoverRef = useRef(onLinkHover);
  hoverRef.current = onLinkHover;

  useEffect(() => {
    openLinkRef.current = onOpenLink;
  }, [onOpenLink]);

  // Every load (first render and each new srcDoc) gets a fresh document, so
  // the listeners and the size observer are attached again each time. Slice
  // 3i (part B I1): this is the one load handler and `detachRef` the one
  // detach for every listener on the frame's document.
  const handleLoad = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    // A new document: the status line names nothing of the old one.
    hoverRef.current?.(null);
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    applyQuotesShown(frame, quotesRef.current);

    // body.scrollHeight follows the content both ways; the root element's
    // never drops below the frame's current height.
    const measure = () => {
      const next = doc.body?.scrollHeight || doc.documentElement?.scrollHeight || 0;
      if (next > 0) setHeight(next);
    };
    const onClick = (event: MouseEvent) => {
      const anchor = closestAnchor(event.target);
      if (anchor === null) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (href !== null && isAllowedLinkUrl(href)) openLinkRef.current(href, anchorText(anchor));
    };
    // Slice 3i: the status line follows the hovered or focused link.
    const onOver = (event: Event) => {
      const anchor = closestAnchor(event.target);
      if (anchor !== null) hoverRef.current?.(hoverOf(anchor));
    };
    const onOut = (event: Event) => {
      const anchor = closestAnchor(event.target);
      if (anchor === null) return;
      const next = closestAnchor((event as MouseEvent | FocusEvent).relatedTarget ?? null);
      if (next !== anchor) hoverRef.current?.(null);
    };

    // Slice 3i (part B B10): letters, Backspace and chords pressed in the
    // message reach the page's hotkeys.
    const onKey = (event: KeyboardEvent) => {
      if (!forwardFrameKey(frame, event)) event.preventDefault();
    };

    doc.addEventListener("click", onClick);
    doc.addEventListener("auxclick", onClick);
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("mouseover", onOver);
    doc.addEventListener("focusin", onOver);
    doc.addEventListener("mouseout", onOut);
    doc.addEventListener("focusout", onOut);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(frame);
      if (doc.body) observer.observe(doc.body);
    }
    measure();

    detachRef.current = () => {
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("auxclick", onClick);
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("mouseover", onOver);
      doc.removeEventListener("focusin", onOver);
      doc.removeEventListener("mouseout", onOut);
      doc.removeEventListener("focusout", onOut);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => () => detachRef.current?.(), []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      style={{ height }}
      className="block w-full rounded-md border border-border"
    />
  );
}
