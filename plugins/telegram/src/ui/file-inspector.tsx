import { Ellipsis, MessageSquare, X } from "lucide-react";
import { useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { DocumentInfo } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { AiTransferButton } from "./ai-transfer.tsx";
import { DocumentButton } from "./document-button.tsx";
import { DocumentIcon } from "./document-icon.tsx";
import { QueueDownloadAction } from "./download-queue.tsx";
import { formatSize } from "./format-size.ts";
import { useTelegramLocale } from "./i18n/index.tsx";
import { MarkdownDocumentPreview } from "./markdown-document.tsx";
import { MessageMenuSlot } from "./message-action-slot.tsx";
import { MessageContent } from "./message-content.tsx";

export function FileInspector({ chatId, message, document, date, shareable, showSource, close, saveDocument, loadMedia, loadVideoStream, forwardActions, reactionActions }: {
  chatId: string;
  message: Message;
  document: DocumentInfo;
  date: ReactNode;
  shareable: boolean;
  showSource?: () => void;
  close: () => void;
} & Pick<ComponentProps<typeof MessageContent>, "saveDocument" | "loadMedia" | "loadVideoStream" | "forwardActions" | "reactionActions">) {
  const { t: tr } = useTelegramLocale();
  const queue = useContext(QueueDownloadAction);
  const menu = useRef<HTMLDetailsElement>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const extension = document.name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? "";
  const stem = extension && document.name !== extension ? document.name.slice(0, -extension.length) : document.name;
  const hasMore = !!(reactionActions || forwardActions || (queue && shareable));
  const save = saveDocument && (() => saveDocument(chatId, message.id));
  return <aside className="mtg-file-inspector" aria-label={tr("File details")} onKeyDown={(event) => {
    const details = menu.current;
    if (event.key !== "Escape" || event.defaultPrevented || !details?.open || !(event.target instanceof Element)
      || !details.contains(event.target) || event.target.closest("dialog")) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    details.querySelector("summary")?.focus();
  }}>
    <header>
      <DocumentIcon document={document} />
      <div className="mtg-file-inspector-identity">
        <h3 title={document.name} aria-label={document.name}><bdi><span>{stem}</span>{stem !== document.name && <span>{extension}</span>}</bdi></h3>
        <div className="mtg-file-inspector-meta">
          {document.sizeBytes !== undefined && <span>{document.approximateSize && "≈ "}{formatSize(document.sizeBytes)}</span>}
          {date}
        </div>
      </div>
      <button type="button" className="mtg-file-tool" aria-label={tr("Close file details")} title={tr("Close file details")}
        onClick={close}><X size={16} aria-hidden="true" /></button>
    </header>
    <div className="mtg-file-inspector-actions" role="group" aria-label={tr("File actions")}>
      {shareable && <MarkdownDocumentPreview iconOnly document={document} chatId={chatId} messageId={message.id} save={save} />}
      {showSource && <button type="button" className="mtg-file-tool" aria-label={tr("Go to message")} title={tr("Go to message")} onClick={showSource}>
        <MessageSquare size={16} aria-hidden="true" /></button>}
      {shareable && <AiTransferButton iconOnly files={[{ id: message.id, chatId, name: document.name }]} />}
      {!document.playbackMime && document.downloadable && saveDocument &&
        <DocumentButton document={document} compactVideo save={save} />}
      {hasMore && <details ref={menu} className="mtg-file-more">
        <summary className="mtg-file-tool" aria-label={tr("More file actions")} title={tr("More file actions")}>
          <Ellipsis size={18} aria-hidden="true" />
        </summary>
        <div ref={setTarget} className="mtg-file-more-contents" />
      </details>}
    </div>
    <MessageMenuSlot.Provider value={{ target, reactions: target, setTarget, setReactions: setTarget }}>
      <MessageContent documentInInspector chatId={chatId} message={message} saveDocument={saveDocument}
        loadMedia={loadMedia} loadVideoStream={loadVideoStream} forwardActions={forwardActions} reactionActions={reactionActions} />
    </MessageMenuSlot.Provider>
  </aside>;
}
