import { useTelegramLocale } from "./i18n/index.tsx";
import { Copy, Download, Ellipsis, ListChecks, Trash2, X } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import type { ForwardDelivery, ForwardPresentation, ForwardResult, ForwardTarget, SelectedText } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { BatchMessageDeletion, type BatchDeletionActions } from "./batch-message-deletion.tsx";
import { ChatReport, type ChatReportActions } from "./chat-report.tsx";
import { isPlainKey } from "./composer-keys.ts";
import { CopySelectedText } from "./copy-selected-text.tsx";
import { QueueDownloadAction } from "./download-queue.tsx";
import { MessageForward, type ForwardActions } from "./message-forward.tsx";

export type MessageSelectionActions = {
  chatReportActions?: ChatReportActions;
  batchDeletion?: BatchDeletionActions;
  saveSelectedAttachments?: (id: string, ids: string[], format?: "html") => Promise<boolean>;
  copySelectedText?: (id: string, ids: string[], format?: "portable") => Promise<SelectedText | null>;
  batchForward?: {
    options: (id: string, ids: string[]) => Promise<boolean>;
    send: (id: string, ids: string[], target: ForwardTarget,
      presentation?: ForwardPresentation, delivery?: ForwardDelivery, comment?: string)
      => Promise<ForwardResult>;
  };
};

export function isSaveableAttachment(row: Message) {
  return !row.retained && !row.pendingDelivery && !row.oneView && !!(row.canSavePhoto || row.document?.downloadable);
}

export function useMessageSelection(chatId: string, byId: ReadonlyMap<string, Message>,
  actions: MessageSelectionActions | undefined, forwardActions: ForwardActions | undefined, shown: boolean,
  deletedIds?: ReadonlySet<string>, scope?: string, chatName?: string) {
  const { t: tr } = useTelegramLocale();
  const report = chatName && actions?.chatReportActions;
  const deletion = actions?.batchDeletion;
  const forward = actions?.batchForward;
  const canForwardSelection = forwardActions && forward && byId.size >= 2;
  const copyText = actions?.copySelectedText;
  const saveAttachments = actions?.saveSelectedAttachments;
  const queue = useContext(QueueDownloadAction);
  function hasQueueableAttachment() {
    for (const message of byId.values()) {
      if (isSaveableAttachment(message)) return true;
    }
    return false;
  }
  const queueOperation = useRef<AbortController>(null);
  const [bulk, setBulk] = useState<{ id: string; ids: string[]; review?: string[]; reporting?: string[]; forwarding?: string[];
    saving?: string[]; download?: "started" | "failed"; queueing?: boolean; queued?: string[];
    queueResult?: { added: number; failed: number } }>();
  useLayoutEffect(() => {
    setBulk(undefined);
    return () => { queueOperation.current?.abort(); queueOperation.current = null; };
  }, [chatId, shown, scope]);
  const selection = bulk?.id === chatId ? bulk : undefined;
  const selectedIds = selection?.ids.filter((id) => byId.has(id) && !deletedIds?.has(id)) ?? [];
  const forwardIds = selection?.forwarding ?? selectedIds;
  const attachmentIds = saveAttachments || queue ? selectedIds.filter((id) => {
    const row = byId.get(id);
    return row && isSaveableAttachment(row);
  }) : [];
  const pendingQueueIds = queue ? attachmentIds.filter((id) => !selection?.queued?.includes(id)) : [];
  const busy = !!(selection?.saving || selection?.queueing);
  const formattedRows = selectedIds.map((id) => byId.get(id)?.richMessage);
  const formattedArchive = saveAttachments && formattedRows.every(Boolean) && formattedRows.some((layout) =>
    layout?.blocks.some((block) => (block.kind === "photo" || block.kind === "document" && block.document.downloadable)
      && !block.spoiler && !block.reference.paid));

  async function download(format?: "html") {
    const ids = format ? selectedIds : attachmentIds;
    if (!saveAttachments || !selection || !ids.length || busy) return;
    setBulk({ ...selection, saving: ids, download: undefined });
    const requested = format ? saveAttachments(chatId, ids, format) : saveAttachments(chatId, ids);
    const result = await requested.then((started) => started ? "started" as const : undefined,
      () => "failed" as const);
    setBulk((current) => current?.saving === ids ? { ...current, saving: undefined, download: result } : current);
  }

  async function queueSelected() {
    if (!queue || !selection || !pendingQueueIds.length || busy || queueOperation.current) return;
    const controller = new AbortController();
    queueOperation.current = controller;
    setBulk({ ...selection, queueing: true, queueResult: undefined });
    const added: string[] = [];
    for (const id of pendingQueueIds) {
      if (controller.signal.aborted) return;
      try {
        if (await queue(chatId, id)) added.push(id);
      } catch {
        // Keep processing the selected files and report the failed item.
      }
    }
    if (controller.signal.aborted) return;
    queueOperation.current = null;
    setBulk((current) => current?.queueing ? {
      ...current, queueing: false, queued: [...(current.queued ?? []), ...added],
      queueResult: { added: added.length, failed: pendingQueueIds.length - added.length },
    } : current);
  }

  function toggleSelected(id: string) {
    setBulk((current) => {
      if (current?.id !== chatId || current.review || current.reporting || current.forwarding || current.saving || current.queueing) return current;
      const ids = current.ids.filter((value) => byId.has(value) && !deletedIds?.has(value));
      if (ids.includes(id)) return { ...current, ids: ids.filter((value) => value !== id), queueResult: undefined };
      return ids.length < 100 ? { ...current, ids: [...ids, id], queueResult: undefined } : current;
    });
  }

  const canSelect = shown && !!byId.size && !!(canForwardSelection || copyText || deletion || saveAttachments || report ||
    (queue && hasQueueableAttachment()));
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (selection && !selection.review && !selection.reporting) cancelButton.current?.focus({ preventScroll: true });
  }, [!!selection, !!selection?.review, !!selection?.reporting]);

  function cancel() {
    if (!selection || selection.review || selection.reporting || selection.forwarding || busy) return false;
    setBulk(undefined);
    return true;
  }

  function start(dismiss?: () => void, iconOnly = false) {
    return canSelect && !selection && <button type="button" className="mtg-action mtg-selection-start"
      aria-label={iconOnly ? tr("Select messages") : undefined} title={iconOnly ? tr("Select messages") : undefined} onClick={() => {
      dismiss?.();
      setBulk({ id: chatId, ids: [] });
    }}><ListChecks size={16} aria-hidden="true" />{!iconOnly && tr("Select messages")}</button>;
  }

  function focusHistory(bar?: Element | null) {
    bar?.parentElement?.querySelector<HTMLElement>(".mtg-history:not([hidden]), .mtg-channel-inbox-history")?.focus({ preventScroll: true });
  }

  const toolbar = shown && selection && <div className="mtg-selection-bar" role="group" aria-label={tr("Message selection")}
    onKeyDown={(event) => {
      if (!isPlainKey(event, "Escape") || event.target instanceof Element &&
        event.target.closest("input:not([type=checkbox]), textarea, select, dialog, [role=dialog], [contenteditable]")) return;
      if (!cancel()) return;
      event.preventDefault();
      event.stopPropagation();
      focusHistory(event.currentTarget);
    }}>
    {selection.review && deletion ? <BatchMessageDeletion chatId={chatId} ids={selection.review} actions={deletion}
        close={(deleted) => setBulk((current) => current && current.review === selection.review
          ? deleted ? undefined : { ...current, review: undefined } : current)} />
      : selection.reporting && report && chatName ? <>
        {selection.reporting.every((id) => selectedIds.includes(id)) ?
          <ChatReport key={chatName} id={chatId} name={chatName} actions={report} messageIds={selection.reporting}
            close={() => setBulk((current) => current?.reporting === selection.reporting && current
              ? { ...current, reporting: undefined } : current)} />
          : <><p role="status">{tr("A selected message is gone. Review your selection again.")}</p>
            <button type="button" className="mtg-action" onClick={() => setBulk({ ...selection, reporting: undefined })}>{tr("Back to selection")}</button></>}
      </>
      : <>
        <div className="mtg-selection-controls">
        <button ref={cancelButton} type="button" className="mtg-selection-button" title={tr("Cancel selection")}
          aria-label={tr("Cancel selection")} disabled={!!selection.forwarding || busy} onClick={(event) => {
            if (cancel()) focusHistory(event.currentTarget.closest(".mtg-selection-bar"));
          }}><X size={16} aria-hidden="true" /></button>
        <output className="mtg-selection-count" aria-live="polite">{selectedIds.length}{tr(" selected")}</output>
        {forwardActions && forward && forwardIds.length >= 2 && !busy && <MessageForward
          chatId={chatId} messageId={forwardIds[0]!} selectionCount={forwardIds.length}
          hasCaption={forwardIds.some((id) => { const row = byId.get(id); return !!(row?.photoCaption || row?.document?.caption); })}
          onOpenChange={(open) => setBulk((current) => current?.id === chatId
            ? { ...current, forwarding: open ? forwardIds : undefined } : current)}
          actions={{ ...forwardActions,
            forwardOptions: (id) => forward.options(id, forwardIds),
            forwardMessage: (id, _, target, _album, presentation, delivery, comment) =>
              forward.send(id, forwardIds, target, presentation, delivery, ...(comment ? [comment] : [])),
          }} />}
        {pendingQueueIds.length > 0 && !selection.forwarding && <button type="button" className="mtg-selection-button"
          aria-label={selection.queueing ? tr("Adding selected attachments…") : tr("Queue {0} {1}", [pendingQueueIds.length, pendingQueueIds.length === 1 ? "attachment" : "attachments"])}
          title={tr("Add to downloads")} disabled={busy} onClick={() => void queueSelected()}>
          <Download size={16} aria-hidden="true" /><span aria-hidden="true">{tr("Downloads")}</span>
        </button>}
        {deletion && !selection.forwarding && <button type="button" className="mtg-selection-button mtg-selection-delete" aria-label={tr("Review selected deletion")}
          title={tr("Delete selected messages")} disabled={selectedIds.length < 2 || busy}
          onClick={() => setBulk({ ...selection, review: selectedIds })}><Trash2 size={16} aria-hidden="true" /><span aria-hidden="true">{tr("Delete")}</span></button>}
        {!selection.forwarding && selectedIds.length > 0 && (copyText || saveAttachments && attachmentIds.length > 0 || report) &&
          <details className="mtg-selection-more" onKeyDown={(event) => {
            if (event.key !== "Escape" || !event.currentTarget.open) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary className="mtg-selection-button" aria-label={tr("More selection actions")} title={tr("More selection actions")}><Ellipsis size={17} aria-hidden="true" /></summary>
            <div className="mtg-selection-extra">
              {copyText && <CopySelectedText key={`${chatId}:${selectedIds.join(",")}`} load={(format) => format ? copyText(chatId, selectedIds, format) : copyText(chatId, selectedIds)}
                allowHtml={selectedIds.some((id) => !!byId.get(id)?.richMessage)} />}
              {saveAttachments && attachmentIds.length > 0 && <button type="button" className="mtg-action"
                disabled={busy} onClick={() => void download()}>{tr("Save ")}{attachmentIds.length} {attachmentIds.length === 1 ? tr("attachment") : tr("attachments")}
              </button>}
              {formattedArchive && <button type="button" className="mtg-action"
                disabled={busy} onClick={() => void download("html")}>{tr("Save HTML and attachments")}</button>}
              {report && <button type="button" className="mtg-action" disabled={busy}
                onClick={() => setBulk({ ...selection, reporting: selectedIds })}>{tr("Report selected messages")}</button>}
            </div>
          </details>}
        </div>
        {selection.download === "started" && <span role="status">{tr("Attachment archive download started.")}</span>}
        {selection.download === "failed" && <span role="alert">{tr("Could not start the attachment archive.")}</span>}
        {selection.queueResult && <span role="status">
          {selection.queueResult.added}{tr(" added to downloads.")}{selection.queueResult.failed > 0 && tr(" {0} could not be added.", [selection.queueResult.failed])}
        </span>}
      </>}
  </div>;

  function checkbox(message: Message) {
    return shown && selection && byId.has(message.id) && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id)
      && <label className="mtg-selection-check"><input type="checkbox" aria-label={tr("Select message")} checked={selectedIds.includes(message.id)}
        disabled={!!selection.review || !!selection.reporting || !!selection.forwarding || busy || selectedIds.length >= 100 && !selectedIds.includes(message.id)}
        onChange={() => toggleSelected(message.id)} /></label>;
  }

  function actionsFor(message: Message, dismiss: () => void) {
    if (!canSelect || selection || !byId.has(message.id) || message.restricted || message.retained
      || message.oneView || message.pendingDelivery || !/^[1-9]\d{0,15}$/.test(message.id)) return null;
    return <>
      {copyText && (message.text || message.photoCaption || message.document?.caption || message.richMessage) &&
        <CopySelectedText label={tr("Copy text")} icon={Copy} load={() => copyText(chatId, [message.id])} />}
      <button type="button" className="mtg-action" onClick={() => {
        setBulk({ id: chatId, ids: [message.id] });
        dismiss();
      }}><ListChecks size={15} aria-hidden="true" />{tr("Select this message")}</button>
    </>;
  }

  return { toolbar, start, cancel, checkbox, actionsFor, selectedIds, available: canSelect && !selection, active: !!selection };
}
