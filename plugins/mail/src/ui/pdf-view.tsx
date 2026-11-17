// The PDF part of the attachment viewer (slice 3h, #50). pdf.js never
// reaches src/ui: the page hands in a PdfEngine (src/adapters/bb/pdf-page.ts
// over pdfjs-dist, started in a blob: worker). A null engine, or one that
// cannot start its worker, means the PDF is download-only; pdf.js never runs
// on BB's main thread (spec resolution 2). One page is drawn at a time,
// annotations are never drawn, and only http(s)/mailto links are listed,
// opened by a click through the page's link opener.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { isAllowedLinkUrl } from "./sanitize.ts";
import { tx } from "./i18n/index.ts";

/** One open PDF (the adapter's pdf.js document). */
export interface PdfDocument {
  pages: number;
  /** Draws page `page` (1-based) to the canvas at `scale`, annotations off. */
  render: (page: number, canvas: HTMLCanvasElement, scale: number) => Promise<void>;
  /** The URLs of the page's Link annotations, as the PDF states them. */
  links: (page: number) => Promise<string[]>;
  close: () => void;
}

/** The port the page injects; open() rejects with PdfUnavailable when its worker cannot start. */
export interface PdfEngine {
  open: (bytes: Uint8Array) => Promise<PdfDocument>;
}

/** The engine's worker could not start here (a CSP, no Worker): download-only. */
export class PdfUnavailable extends Error {
  constructor() {
    super("PDF preview is not available here");
    this.name = "PdfUnavailable";
  }
}

/** Pages a PDF may show; longer documents show their first PDF_PAGES_MAX. */
export const PDF_PAGES_MAX = 500;
export const PDF_ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const PDF_PARTIAL_NOTE = "Some parts of this PDF may not display";
export const PDF_UNAVAILABLE_TEXT = "PDF preview is not available here";

/** The links worth listing: http(s) and mailto only, each once. */
export function pdfLinks(urls: readonly string[]): string[] {
  return [...new Set(urls.filter(isAllowedLinkUrl))];
}

type Phase =
  | { kind: "opening" }
  | { kind: "unavailable" }
  | { kind: "failed"; error: string }
  | { kind: "open"; doc: PdfDocument };

export function PdfView({
  engine,
  bytes,
  onOpenLink,
  onDownload,
}: {
  engine: PdfEngine | null;
  bytes: Uint8Array;
  onOpenLink: (url: string) => void;
  onDownload: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(engine === null ? { kind: "unavailable" } : { kind: "opening" });
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(2);
  const [links, setLinks] = useState<string[]>([]);
  const [drawError, setDrawError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (engine === null) {
      setPhase({ kind: "unavailable" });
      return;
    }
    let live = true;
    let opened: PdfDocument | null = null;
    setPhase({ kind: "opening" });
    engine.open(bytes).then(
      (doc) => {
        opened = doc;
        if (live) setPhase({ kind: "open", doc });
        else doc.close();
      },
      (error: unknown) => {
        if (!live) return;
        setPhase(error instanceof PdfUnavailable ? { kind: "unavailable" } : { kind: "failed", error: "This PDF could not be read" });
      },
    );
    return () => {
      live = false;
      opened?.close();
    };
  }, [engine, bytes]);

  const doc = phase.kind === "open" ? phase.doc : null;
  const pages = doc === null ? 0 : Math.min(doc.pages, PDF_PAGES_MAX);
  const scale = PDF_ZOOMS[zoom] ?? 1;

  useEffect(() => {
    if (doc === null || canvasRef.current === null) return;
    let live = true;
    setDrawError(null);
    doc.render(page, canvasRef.current, scale).catch(() => {
      if (live) setDrawError("This page could not be drawn");
    });
    doc.links(page).then(
      (urls) => {
        if (live) setLinks(pdfLinks(urls));
      },
      () => {
        if (live) setLinks([]);
      },
    );
    return () => {
      live = false;
    };
  }, [doc, page, scale]);

  const download = (
    <Button variant="outline" size="sm" className="h-7" onClick={onDownload}>
      <Icon name="Download" fallback="Paperclip" aria-hidden />
      {tx("Download")}
    </Button>
  );

  if (phase.kind === "unavailable" || phase.kind === "failed") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className="text-sm text-muted-foreground">
          {phase.kind === "failed" ? phase.error : PDF_UNAVAILABLE_TEXT}
        </p>
        {download}
      </div>
    );
  }
  if (phase.kind === "opening") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {tx("Opening the PDF\u2026")}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div role="toolbar" aria-label="PDF" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <Button variant="ghost" size="icon" className="size-7" aria-label={tx("Previous page")} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          <Icon name="ChevronLeft" fallback="ArrowLeft" aria-hidden />
        </Button>
        <span aria-live="polite">{tx("Page {page} of {pages}", { page, pages })}</span>
        <Button variant="ghost" size="icon" className="size-7" aria-label={tx("Next page")} disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
          <Icon name="ChevronRight" fallback="ArrowRight" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" aria-label={tx("Zoom out")} disabled={zoom <= 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
          <Icon name="ZoomOut" fallback="Minus" aria-hidden />
        </Button>
        <span>{`${Math.round(scale * 100)}%`}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={tx("Zoom in")}
          disabled={zoom >= PDF_ZOOMS.length - 1}
          onClick={() => setZoom((z) => Math.min(PDF_ZOOMS.length - 1, z + 1))}
        >
          <Icon name="ZoomIn" fallback="Plus" aria-hidden />
        </Button>
        <span className="flex-1" />
        {download}
      </div>
      <p className="text-xs text-muted-foreground">{PDF_PARTIAL_NOTE}</p>
      {doc !== null && doc.pages > PDF_PAGES_MAX ? (
        <p className="text-xs text-muted-foreground">{tx("Only the first {p1} pages show here", { p1: PDF_PAGES_MAX })}</p>
      ) : null}
      {drawError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {drawError}
        </p>
      ) : null}
      <div className="min-h-0 overflow-auto rounded-md border border-border bg-muted">
        <canvas ref={canvasRef} aria-label={tx("Page {page}", { page })} className="mx-auto block" />
      </div>
      {links.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{tx("Links in this PDF ({length})", { length: links.length })}</summary>
          <ul aria-label={tx("Links in this PDF")} className="mt-1 flex flex-col gap-0.5">
            {links.map((url) => (
              <li key={url}>
                <button type="button" className="break-all text-left text-foreground underline" onClick={() => onOpenLink(url)}>
                  {url}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
