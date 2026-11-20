import { useTelegramLocale } from "./i18n/index.tsx";
import { Component, createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentInfo, RichAttachmentReference } from "../core/contract.ts";
import { isMarkdownDocument, isPlainTextDocument, maxMarkdownDocumentBytes } from "../core/markdown-document.ts";
import { webLink } from "../core/message-links.ts";
import { DocumentButton } from "./document-button.tsx";
import { MediaViewerFrame } from "./media-viewer-frame.tsx";

export type LoadMarkdownDocument = (chatId: string, messageId: string, attachment?: RichAttachmentReference, format?: "text") => Promise<string>;

export const MarkdownDocumentLoader = createContext<LoadMarkdownDocument | undefined>(undefined);

class MarkdownRenderBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p role="alert">{this.props.fallback}</p> : this.props.children;
  }
}

export function MarkdownDocumentPreview({ document, chatId, messageId, attachment, iconOnly, save }: {
  document: DocumentInfo; chatId: string; messageId: string; attachment?: RichAttachmentReference;
  iconOnly?: boolean; save?: () => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const load = useContext(MarkdownDocumentLoader);
  const dialog = useRef<HTMLDialogElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const title = useId();
  const [result, setResult] = useState<{ text: string } | "loading" | "failed">();
  const markdown = isMarkdownDocument(document.name);
  if (!load || !document.downloadable || (!markdown && !isPlainTextDocument(document.name))
    || !document.approximateSize && (document.sizeBytes ?? 0) > maxMarkdownDocumentBytes) return null;

  function preview() {
    if (!load || !dialog.current) return;
    if (!dialog.current.open) dialog.current.showModal();
    closer.current?.focus();
    const current = ++request.current;
    setResult("loading");
    const pending = markdown ? load(chatId, messageId, attachment) : load(chatId, messageId, attachment, "text");
    void pending.then(
      (text) => { if (request.current === current) setResult({ text }); },
      () => { if (request.current === current) setResult("failed"); },
    );
  }

  const content = <>
      {result === "loading" && <p role="status">{tr("Loading file preview…")}</p>}
      {result === "failed" && <div>
        <p role="alert">{tr("Could not preview this file. The preview supports UTF-8 files up to 128 KiB.")}</p>
        <button type="button" className="mtg-action" onClick={preview}>{tr("Retry")}</button>
      </div>}
      {result && typeof result === "object" && <article>
        {result.text ? markdown ? <MarkdownRenderBoundary fallback={tr("Could not render this Markdown file.")}>
          <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(value) => webLink(value)?.href}
            components={{
              img: ({ alt }) => alt ? <span>{alt}</span> : null,
              a: ({ href, children }) => href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
            }}>{result.text}</Markdown>
        </MarkdownRenderBoundary> : <pre>{result.text}</pre> : <p>{tr("This file is empty.")}</p>}
      </article>}
  </>;

  const label = tr(iconOnly || !markdown ? "Preview file" : "Preview Markdown");
  return <>
    <button ref={trigger} type="button" className={iconOnly ? "mtg-file-tool" : "mtg-action"} title={label} aria-label={label}
      aria-haspopup="dialog" onClick={preview}>{iconOnly ? <Eye size={17} aria-hidden="true" /> : label}</button>
    <dialog ref={dialog} aria-labelledby={title} className="mtg-media-viewer mtg-markdown-document" onClose={(event) => {
      if (event.target !== event.currentTarget) return;
      event.stopPropagation();
      request.current++;
      setResult(undefined);
      trigger.current?.focus({ preventScroll: true });
    }}>
      <MediaViewerFrame title={<h2 id={title} title={document.name}><bdi>{document.name}</bdi></h2>} closeRef={closer}
        closeLabel={tr("Close preview")} close={() => dialog.current?.close()}
        actions={save && <DocumentButton document={document} compactVideo save={save} />}>
        <div className="mtg-document-preview-content">{content}</div>
      </MediaViewerFrame>
    </dialog>
  </>;
}
