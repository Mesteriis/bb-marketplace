// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/components/email/EmailRenderer.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// One message body. HTML goes into a sandboxed iframe that can never run
// scripts; the parent sizes it to its content and handles its link clicks.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageBody } from "../core/index.ts";
import { isAllowedLinkUrl, sanitizeEmailHtml } from "./sanitize.ts";

const INITIAL_HEIGHT = 120;

export interface MessageFrameProps {
  body: MessageBody;
  /** Accessible name of the frame, e.g. "Message from Ada". */
  title: string;
  /** Called with an http(s) or mailto URL the owner clicked. */
  onOpenLink: (url: string) => void;
}

/** Duck-typed: the click target lives in the frame's own realm. */
function closestAnchor(target: EventTarget | null): Element | null {
  const node = target as { closest?: (selector: string) => Element | null } | null;
  return typeof node?.closest === "function" ? node.closest("a, area") : null;
}

export function MessageFrame({ body, title, onOpenLink }: MessageFrameProps) {
  const srcDoc = useMemo(
    () => (body.html !== null ? sanitizeEmailHtml(body.html) : null),
    [body.html],
  );

  if (srcDoc === null) {
    return body.text !== null && body.text.trim() !== "" ? (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
        {body.text}
      </pre>
    ) : (
      <p className="text-sm text-muted-foreground">This message has no text.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <HtmlFrame srcDoc={srcDoc} title={title} onOpenLink={onOpenLink} />
      {body.htmlTruncated ? (
        <p className="text-xs text-muted-foreground">
          This message is very long; the end is not shown.
        </p>
      ) : null}
    </div>
  );
}

function HtmlFrame({
  srcDoc,
  title,
  onOpenLink,
}: {
  srcDoc: string;
  title: string;
  onOpenLink: (url: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const openLinkRef = useRef(onOpenLink);
  const detachRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);

  useEffect(() => {
    openLinkRef.current = onOpenLink;
  }, [onOpenLink]);

  // Every load (first render and each new srcDoc) gets a fresh document, so
  // the listener and the size observer are attached again each time.
  const handleLoad = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;

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
      if (href !== null && isAllowedLinkUrl(href)) openLinkRef.current(href);
    };

    doc.addEventListener("click", onClick);
    doc.addEventListener("auxclick", onClick);
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
