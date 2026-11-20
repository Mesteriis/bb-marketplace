import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { welcomeRichEditDraft } from "../core/contract.ts";
import type { PhotoSize, RichAttachmentReference, RichEdit, SendResult, RichInline, RichMessageBlock, RichMessageLayout, TelegramPhoto, WelcomeRichComposeDraft, WelcomeRichEditDraft } from "../core/contract.ts";
import { PhotoPreview } from "./photo-preview.tsx";
import { RichMessageComposer, type RichMessageComposerActions } from "./rich-message-composer.tsx";
import { ExpandableQuote, MessageQuoteFocus, MessageText } from "./message-text.tsx";
import { CopyTextAction, LinkAction } from "./message-action-button.tsx";
import { OrderedPlaybackQueueProvider } from "./note-playback-queue.tsx";
import type { LoadGroupEmoji } from "./group-emoji-picker.tsx";
import { inlineFormulaReplacements, MathFormula } from "./math-formula.tsx";
import { richQuoteParts, richQuoteRanges } from "../core/rich-message-text.ts";
import { LoadRichBankCard, RichBankCardAction } from "./rich-bank-card.tsx";
import { telegramTonWalletLink } from "../core/ton-address.ts";

const RichQuoteFocus = createContext<ReturnType<typeof richQuoteRanges>>(undefined);
const RichQuoteOffsets = createContext<ReadonlyMap<RichInline | RichMessageBlock, number> | undefined>(undefined);
const RichEmojiActions = createContext(false);
export const RunRichBotCommand = createContext<((chat: string, message: string, command: string) => Promise<SendResult>) | undefined>(undefined);
const RichMessageSource = createContext<{ chatId: string; messageId: string } | undefined>(undefined);

function RichBotCommandAction({ command, run, children }: { command: string; run: () => Promise<SendResult>; children: ReactNode }) {
  const { t: tr } = useTelegramLocale();
  const inFlight = useRef(false);
  const [status, setStatus] = useState<"sending" | SendResult["state"]>();
  async function activate() {
    if (inFlight.current || status === "unknown") return;
    inFlight.current = true;
    setStatus("sending");
    try { setStatus((await run()).state); }
    catch { setStatus("unknown"); }
    finally { inFlight.current = false; }
  }
  return <><button type="button" className="mtg-instant-view-reference" title={tr("Send {0}", [command])}
    disabled={status === "sending" || status === "unknown"} onClick={() => void activate()}>{children}</button>
    {status === "failed" && <span role="status">{tr(" Command could not be sent.")}</span>}
    {status === "unknown" && <span role="status">{tr(" Check the conversation for the command before sending again.")}</span>}
  </>;
}

function Content({ content, inertEmoji = false }: { content: RichInline; inertEmoji?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const emojiActions = useContext(RichEmojiActions);
  const quoteRange = useContext(RichQuoteFocus)?.get(content);
  const offset = useContext(RichQuoteOffsets)?.get(content);
  const buttons = content.inlineButtons ?? [];
  const source = useContext(RichMessageSource);
  const runCommand = useContext(RunRichBotCommand);
  const loadBankCard = useContext(LoadRichBankCard);
  const overlapsButton = ({ offset, length }: { offset: number; length: number }) =>
    buttons.some((entry) => entry.offset < offset + length && entry.offset + entry.length > offset);
  const formulas = inlineFormulaReplacements(content.text, content.formulas)?.filter((part) => !overlapsButton(part)) ?? [];
  function canActivate({ offset, length }: { offset: number; length: number }) {
    const end = offset + length;
    return !inertEmoji && end <= content.text.length && !overlapsButton({ offset, length })
      && ![...(content.links ?? []), ...(content.customEmoji ?? []), ...formulas]
        .some((range) => range.offset < end && range.offset + range.length > offset);
  }
  const commands = source && runCommand ? (content.botCommands ?? []).filter(canActivate).map(({ offset, length, command }) => ({
    offset, length, content: (label: ReactNode) => <RichBotCommandAction key={command} command={command}
      run={() => runCommand(source.chatId, source.messageId, command)}>{label}</RichBotCommandAction>,
  })) : [];
  const cards = source && loadBankCard ? (content.bankCards ?? []).filter(canActivate).map(({ offset, length, reference }) => ({
    offset, length, content: (label: ReactNode) => <RichBankCardAction key={reference}
      load={(mode) => loadBankCard(source.chatId, source.messageId, reference, mode)}>{label}</RichBankCardAction>,
  })) : [];
  const addresses = source ? (content.tonAddresses ?? []).filter(canActivate).flatMap(({ offset, length, address }) => {
    const href = telegramTonWalletLink(address);
    return href ? [{ offset, length, content: (label: ReactNode) =>
      <a href={href} className="mtg-instant-view-reference" title={tr("Open in Telegram Wallet: {0}", [address])}
        aria-label={tr("Open in Telegram Wallet: {0}", [address])} rel="noreferrer">{label}</a> }] : [];
  }) : [];
  const body = <MessageText {...content} links={content.links?.filter((part) => !overlapsButton(part))}
    customEmoji={content.customEmoji?.filter((part) => !overlapsButton(part))}
    inline quoteRange={quoteRange} quoteSelection={offset !== undefined} emojiStatusActions={emojiActions && !inertEmoji}
    replacements={[...formulas, ...commands, ...cards, ...addresses, ...buttons.map(({ offset, length, button }) => ({ offset, length,
      content: button.kind === "url" ? <LinkAction button={button} /> : <CopyTextAction button={button} />,
    }))]} />;
  return offset === undefined ? body : <span data-reply-rich-part={offset}>{body}</span>;
}

export type RichPhotoLoader = (chatId: string, messageId: string, size?: PhotoSize, attachment?: RichAttachmentReference) => Promise<TelegramPhoto>;

export type RichDocumentBlock = Extract<RichMessageBlock, { kind: "document" }>;
export function embeddedPlaybackId(messageId: string, { index, fileId }: RichAttachmentReference) {
  return `${messageId}:attachment:${index}:${fileId}`;
}

export function isRichAudioTrack(block: RichMessageBlock): block is RichDocumentBlock {
  return block.kind === "document" && block.media === "audio" && !block.spoiler && !block.loop && !block.reference.paid
    && block.document.downloadable && block.document.playbackMime?.startsWith("audio/") === true;
}

type AttachmentContext = {
  chatId: string;
  messageId: string;
  loadPhoto?: RichPhotoLoader;
  renderDocument?: (block: RichDocumentBlock) => ReactNode;
};

function MediaCaption({ content, credit }: { content: RichInline; credit?: RichInline }) {
  if (!content.text && !credit?.text) return null;
  return <figcaption>
    <Content content={content} />
    {credit?.text && <div><Content content={credit} /></div>}
  </figcaption>;
}

function EmbeddedPhoto({ block, chatId, messageId, loadPhoto }: AttachmentContext & { block: Extract<RichMessageBlock, { kind: "photo" }> }) {
  const { t: tr } = useTelegramLocale();
  const { index, fileId } = block.reference;
  const load = useCallback((id: string, parent: string, size?: PhotoSize) => {
    if (!loadPhoto) return Promise.reject(new Error("Embedded photo is unavailable."));
    return loadPhoto(id, parent, size, { index, fileId });
  }, [loadPhoto, index, fileId]);
  return <figure>
    {loadPhoto ? <PhotoPreview chatId={chatId} messageId={messageId} load={load} spoiler={block.spoiler} dimensions={block.dimensions} />
      : <p>{tr("Photo unavailable")}</p>}
    <MediaCaption content={block.content} credit={block.credit} />
  </figure>;
}

function Block({ block, ...context }: AttachmentContext & { block: RichMessageBlock }) {
  const { t: tr } = useTelegramLocale();
  const quoteRanges = useContext(RichQuoteFocus);
  const quoteOffset = useContext(RichQuoteOffsets)?.get(block);
  switch (block.kind) {
    case "rule": return <hr />;
    case "buttons": return <div className="mtg-instant-view-button-row" data-align={block.align}>
      {block.buttons.map((button, index) => button.kind === "url"
        ? <LinkAction key={index} button={button} /> : <CopyTextAction key={index} button={button} />)}
    </div>;
    case "math": {
      const formula = quoteOffset === undefined ? <MathFormula expression={block.expression} displayMode />
        : <span data-reply-rich-atom={block.expression.length}><MathFormula expression={block.expression} displayMode /></span>;
      return <div className="mtg-rich-formula" data-reply-rich-part={quoteOffset}>{quoteRanges?.has(block)
        ? <mark className="mtg-search-match" data-reply-quote-match>{formula}</mark> : formula}</div>;
    }
    case "thinking": return <p role="status" aria-label={tr("Preparing reply")}>
      {block.content.text ? <Content content={block.content} inertEmoji /> : tr("Thinking…")}
    </p>;
    case "title": return <h3><Content content={block.content} /></h3>;
    case "heading": return <h4 data-heading-size={block.headingSize}><Content content={block.content} /></h4>;
    case "quote": {
      const body = <>
        <Content content={block.content} />
        {block.continuation?.map((content, index) => <div className="mtg-rich-continuation" key={index}><Content content={content} /></div>)}
        {!!block.credit?.text && <footer><Content content={block.credit} /></footer>}
      </>;
      const quoteInBlock = [block.content, ...(block.continuation ?? []), block.credit].some((part) => part && quoteRanges?.has(part));
      return block.expandable ? <ExpandableQuote key={`${quoteInBlock}:${block.content.text}`} initiallyOpen={quoteInBlock}>{body}</ExpandableQuote>
        : <blockquote>{body}</blockquote>;
    }
    case "code": {
      const code = <pre><code><Content content={block.content} /></code></pre>;
      return block.language ? <figure className="mtg-rich-code"><figcaption><bdi>{block.language}</bdi></figcaption>{code}</figure> : code;
    }
    case "photo": return <EmbeddedPhoto key={block.reference.fileId} block={block} {...context} />;
    case "document": return <figure>
      {context.renderDocument?.(block) ?? <p>{tr("Download unavailable")}</p>}
      <MediaCaption content={block.content} credit={block.credit} />
    </figure>;
    case "attachment": return <figure><p><em>{tr("Attachment")}</em></p><MediaCaption content={block.content} credit={block.credit} /></figure>;
    case "list": {
      const ordered = block.items.some(({ numbering }) => numbering);
      const List = ordered ? "ol" : "ul";
      return <List className="mtg-rich-list" role="list" type={ordered ? block.items[0]?.numbering : undefined}>
        {block.items.map(({ label, content, continuation, numbering, number, checked }, index) => <li key={index} value={numbering ? number : undefined}
          data-numbering={ordered ? numbering ?? "bullet" : undefined}
          data-custom-marker={!!label || checked !== undefined || undefined}>
          {label && <bdi>{label} </bdi>}
          {checked !== undefined && <input type="checkbox" disabled checked={checked} aria-label={tr("Task status")} />}
          <Content content={content} />
          {continuation?.map((part, paragraph) => <div className="mtg-rich-continuation" key={paragraph}><Content content={part} /></div>)}
        </li>)}
      </List>;
    }
    case "table": return <div className="mtg-rich-table"><table data-bordered={block.bordered !== false}
      data-striped={block.striped || undefined} data-compact={block.compact || undefined}>
      {!!block.caption.text && <caption><Content content={block.caption} /></caption>}
      <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map(({ header, content, colSpan, rowSpan, align, verticalAlign, invisible }, column) => {
        const Cell = header ? "th" : "td";
        return <Cell key={column} colSpan={colSpan} rowSpan={rowSpan} aria-hidden={invisible}
          style={{ textAlign: align, verticalAlign, visibility: invisible ? "hidden" : undefined }}>
          <Content content={content} inertEmoji={invisible} />
        </Cell>;
      })}</tr>)}</tbody>
    </table></div>;
    default: return <p><Content content={block.content} /></p>;
  }
}

export const EditRichMessage = createContext<{
  load: RichMessageComposerActions["richMessageLimits"];
  save: (chatId: string, messageId: string, revision: string, draft: WelcomeRichEditDraft) => Promise<SendResult>;
  upload?: (chatId: string, messageId: string, revision: string, draft: WelcomeRichComposeDraft, files: Blob[],
    progress: (offset: number, total: number, canCancel: boolean) => void, signal: AbortSignal) => Promise<SendResult | { state: "cancelled" }>;
} | null>(null);

export function RichMessage({ layout, edit, loadGroupEmoji, audioPlaylist = false, canQuote, emojiActions = false, sourceActions = false, ...context }: AttachmentContext & {
  layout: RichMessageLayout; edit?: RichEdit; loadGroupEmoji?: LoadGroupEmoji; audioPlaylist?: boolean; canQuote?: boolean; emojiActions?: boolean; sourceActions?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const actions = useContext(EditRichMessage);
  const quoteFocus = useContext(MessageQuoteFocus);
  const [editing, setEditing] = useState<RichEdit>();
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const [busy, setBusy] = useState(false);
  const uploadController = useRef<AbortController>(undefined);
  const [progress, setProgress] = useState<{ offset: number; total: number; canCancel: boolean }>();
  useEffect(() => () => uploadController.current?.abort(), []);
  const [status, setStatus] = useState("");
  const [updated, setUpdated] = useState<{ revision: string; layout: RichMessageLayout; edit?: RichEdit }>();
  const override = updated?.revision === edit?.revision ? updated : undefined;
  const current = override?.layout ?? layout;
  const quoteOffsets = useMemo(() => canQuote && current.quoteLayout
    ? new Map(richQuoteParts(current).map(({ part, offset }) => [part, offset] as const)) : undefined, [canQuote, current]);
  const quoteRanges = quoteFocus?.id === context.messageId
    ? richQuoteRanges(current, quoteFocus.quote, quoteFocus.quote.richEmoji ?? []) : undefined;
  const editable = override ? override.edit : edit;
  const trackIds = useMemo(() => current.blocks.filter(isRichAudioTrack)
    .map((block) => embeddedPlaybackId(context.messageId, block.reference)), [current.blocks, context.messageId]);
  function cancel() {
    restoreFocus.current = true;
    setStatus("");
    setEditing(undefined);
  }

  return <>
    <article className="mtg-rich-message" dir={current.rtl ? "rtl" : "auto"} aria-label={tr("Rich Telegram message")}
      data-reply-rich-message={quoteOffsets?.size ? context.messageId : undefined}>
      <OrderedPlaybackQueueProvider ids={trackIds} enabled={audioPlaylist && trackIds.length > 1} kind="rich">
        <RichQuoteFocus.Provider value={quoteRanges}>
          <RichQuoteOffsets.Provider value={quoteOffsets}>
            <RichEmojiActions.Provider value={emojiActions}>
              <RichMessageSource.Provider value={sourceActions ? { chatId: context.chatId, messageId: context.messageId } : undefined}>
                {current.blocks.map((block, index) => <Block key={index} block={block} {...context} />)}
              </RichMessageSource.Provider>
            </RichEmojiActions.Provider>
          </RichQuoteOffsets.Provider>
        </RichQuoteFocus.Provider>
      </OrderedPlaybackQueueProvider>
      {!current.complete && <p className="mtg-reply-quote">{tr("Some parts of this message are unavailable in BB.")}</p>}
    </article>
    {actions && (editing
      ? <>
        <RichMessageComposer key={editing.revision} load={actions.load} existingDraft={editing.draft} textOnly={!actions.upload} disabled={busy} scheduled={false} cancel={cancel}
          groupEmoji={loadGroupEmoji ? { id: context.chatId, load: loadGroupEmoji } : undefined}
          saveExisting={(draft, files) => {
            if (busy) return;
            const parsed = welcomeRichEditDraft.safeParse(draft);
            const upload = actions.upload;
            if (files.length ? !upload : !parsed.success) return;
            setBusy(true);
            setStatus("");
            const request = files.length && upload ? (() => {
              const controller = new AbortController();
              uploadController.current = controller;
              setProgress({ offset: 0, total: files.reduce((sum, file) => sum + file.size, 0), canCancel: true });
              return upload(context.chatId, context.messageId, editing.revision, draft, files, (offset, total, canCancel) => {
                if (uploadController.current === controller) setProgress({ offset, total, canCancel });
              }, controller.signal);
            })() : actions.save(context.chatId, context.messageId, editing.revision, parsed.data!);
            void request.then((result) => {
              if (result.state === "sent" && result.message.richMessage) {
                setUpdated({ revision: editing.revision, layout: result.message.richMessage, edit: result.message.richEdit });
                cancel();
              } else {
                setStatus(result.state === "cancelled" ? "Upload cancelled. Your edit is still here."
                  : result.state === "unknown" ? "Edit unconfirmed. Check the message before retrying."
                    : "Could not save. The message or your edit permissions may have changed.");
              }
            }, () => setStatus("Edit unconfirmed. Check the message before retrying.")).finally(() => {
              uploadController.current = undefined;
              setProgress(undefined);
              setBusy(false);
            });
          }} />
        {progress && <>
          <progress aria-label={tr("Formatted attachment upload")} value={progress.offset} max={progress.total} />
          <button type="button" className="mtg-action" disabled={!progress.canCancel} onClick={() => {
            uploadController.current?.abort();
            setProgress({ ...progress, canCancel: false });
          }}>{tr("Cancel upload")}</button>
        </>}
        <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel edit")}</button>
      </> : editable && <button ref={editButton} type="button" className="mtg-action" onClick={() => {
        setStatus("");
        setEditing(editable);
      }}>{tr("Edit formatted message")}</button>)}
    {status && <p role="status">{tr(status)}</p>}
  </>;
}
