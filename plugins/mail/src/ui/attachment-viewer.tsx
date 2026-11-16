// Mail's own attachment viewer (slice 3h, #50). The page asks for a view
// ticket, fetches the bytes and builds a Blob with the type the server
// decided after sniffing them; a blob: URL is made only for raster images,
// revoked when the viewer closes, and never navigated to or handed to a link
// opener. Text goes to the host's code view (or a <pre>), PDF to pdf-view.
// SVG, HTML and every other type are download-only (spec resolution 13).
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { FileKind } from "../core/index.ts";
import { VIEW_CAPS } from "../core/file-kinds.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { formatFileSize } from "./files-view.tsx";
import { PdfView, type PdfEngine } from "./pdf-view.tsx";
import { stopEscape } from "./shortcuts.ts";

export const NOT_VIEWABLE_TEXT = "This file type opens only after download";
export const TEXT_CUT_TEXT = "Showing the first 2 MB";

/** What the viewer shows: one attachment of one message. */
export interface ViewRequest {
  messageId: string;
  partId: string;
  filename: string | null;
  mimeType: string;
  size: number;
  kind: FileKind;
}

/** attachment_view_ticket's answer. */
export interface ViewTicket {
  url: string;
  kind: FileKind;
  mimeType: string;
  size: number;
}

/** Raster image types a blob may carry; SVG never (it is a document). */
const RASTER = /^image\/(png|jpeg|gif|webp|avif|bmp)$/i;

/** Whether the viewer offers View for a kind and type at all. */
export function viewerShows(kind: FileKind, mimeType: string): boolean {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type === "image/svg+xml" || type === "text/html") return false;
  return kind === "image" || kind === "pdf" || kind === "text" || kind === "calendar";
}

/** The bytes as text in the server's charset; UTF-8 when the label is unknown. */
export function decodeText(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

type Shown =
  | { kind: "loading" }
  | { kind: "refused"; text: string }
  | { kind: "image"; url: string }
  | { kind: "text"; content: string; cut: boolean }
  | { kind: "pdf"; bytes: Uint8Array };

export interface ViewerHost {
  getTicket: (request: ViewRequest) => Promise<ViewTicket>;
  /** fetch() of the ticket URL. */
  fetch: (url: string) => Promise<Response>;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  /** The host's code view (BB's SourceCode); absent: a <pre>. */
  renderCode?: (content: string, path: string) => ReactNode;
  /** The host's image lightbox; absent: an <img> in the sheet. */
  Lightbox?: ComponentType<{ imageSrc: string | null; imageAlt: string; title: string; isOpen?: boolean; onClose(): void }>;
  pdf: PdfEngine | null;
}

export function AttachmentViewer({
  request,
  host,
  onDownload,
  onSave,
  onOpenLink,
  onClose,
}: {
  request: ViewRequest | null;
  host: ViewerHost;
  onDownload: (request: ViewRequest) => void;
  /** Save to project...; absent: not offered. */
  onSave?: (request: ViewRequest) => void;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<Shown>({ kind: "loading" });

  useEffect(() => {
    if (request === null) return;
    let live = true;
    let objectUrl: string | null = null;
    setShown({ kind: "loading" });
    const refuse = (text: string) => {
      if (live) setShown({ kind: "refused", text });
    };
    void (async () => {
      if (!viewerShows(request.kind, request.mimeType)) return refuse(NOT_VIEWABLE_TEXT);
      let ticket: ViewTicket;
      try {
        ticket = await host.getTicket(request);
      } catch (error) {
        return refuse(error instanceof Error && error.message !== "" ? error.message : NOT_VIEWABLE_TEXT);
      }
      if (!viewerShows(ticket.kind, ticket.mimeType)) return refuse(NOT_VIEWABLE_TEXT);
      let response: Response;
      try {
        response = await host.fetch(ticket.url);
      } catch {
        return refuse("The file could not be loaded");
      }
      if (!response.ok) return refuse(response.status === 409 ? NOT_VIEWABLE_TEXT : "The file could not be loaded");
      // The server's type, decided after sniffing the bytes.
      const contentType = response.headers.get("content-type") ?? ticket.mimeType;
      const type = contentType.split(";")[0]!.trim().toLowerCase();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!live) return;
      if (ticket.kind === "image") {
        if (!RASTER.test(type)) return refuse(NOT_VIEWABLE_TEXT);
        objectUrl = host.createObjectUrl(new Blob([bytes], { type }));
        if (live) setShown({ kind: "image", url: objectUrl });
        else host.revokeObjectUrl(objectUrl);
        return;
      }
      if (ticket.kind === "pdf") {
        if (type !== "application/pdf") return refuse(NOT_VIEWABLE_TEXT);
        setShown({ kind: "pdf", bytes });
        return;
      }
      if (!type.startsWith("text/")) return refuse(NOT_VIEWABLE_TEXT);
      const content = decodeText(bytes, /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8");
      setShown({ kind: "text", content, cut: ticket.size > VIEW_CAPS.textShown });
    })();
    return () => {
      live = false;
      if (objectUrl !== null) host.revokeObjectUrl(objectUrl);
    };
  }, [request, host]);

  const name = request?.filename ?? "Unnamed attachment";
  let body: ReactNode = null;
  if (request !== null) {
    switch (shown.kind) {
      case "loading":
        body = (
          <p role="status" className="text-sm text-muted-foreground">
            {"Loading\u2026"}
          </p>
        );
        break;
      case "refused":
        body = <p className="text-sm text-muted-foreground">{shown.text}</p>;
        break;
      case "image":
        body =
          host.Lightbox !== undefined ? (
            <host.Lightbox imageSrc={shown.url} imageAlt={name} title={name} isOpen onClose={onClose} />
          ) : (
            <div className="flex min-h-0 justify-center overflow-auto">
              <img src={shown.url} alt={name} referrerPolicy="no-referrer" decoding="async" className="max-h-[70vh] max-w-full object-contain" />
            </div>
          );
        break;
      case "text":
        body = (
          <div className="flex min-h-0 flex-col gap-1">
            {shown.cut ? (
              <p className="text-xs text-muted-foreground">
                {TEXT_CUT_TEXT}
                {" \u00b7 "}
                <button type="button" className="underline" onClick={() => onDownload(request)}>
                  Download
                </button>
              </p>
            ) : null}
            <div className="max-h-[70vh] min-h-0 overflow-auto">
              {host.renderCode !== undefined ? (
                host.renderCode(shown.content, name)
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs text-foreground">{shown.content}</pre>
              )}
            </div>
          </div>
        );
        break;
      case "pdf":
        body = <PdfView engine={host.pdf} bytes={shown.bytes} onOpenLink={onOpenLink} onDownload={() => onDownload(request)} />;
        break;
    }
  }
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle className="truncate">{name}</DialogTitle>
          <DialogDescription>{request !== null ? `${request.mimeType} \u00b7 ${formatFileSize(request.size)}` : ""}</DialogDescription>
        </DialogHeader>
        {request !== null ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" className="h-7" onClick={() => onDownload(request)}>
              <Icon name="Download" fallback="Paperclip" aria-hidden />
              Download
            </Button>
            {onSave !== undefined ? (
              <Button variant="ghost" size="sm" className="h-7" onClick={() => onSave(request)}>
                <Icon name="FolderInput" fallback="Folder" aria-hidden />
                {"Save to project\u2026"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {body}
      </DialogContent>
    </Dialog>
  );
}
