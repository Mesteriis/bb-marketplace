import { useTelegramLocale } from "./i18n/index.tsx";
import { Bold, Ellipsis, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { Button } from "../../components/ui/button.tsx";
import type { CustomEmojiRange, GroupEmojiChoice, MessageStyle, StyledRange, SyncedDraft } from "../core/contract.ts";
import { captionFormatForRanges, isQuoteStyle, moveDraftRanges, moveRangesThroughEdit, trimDraftRanges, validDraftCustomEmoji, validDraftLinks, validDraftStyles } from "../core/draft-formatting.ts";
import { webLink, type MessageLink } from "../core/message-links.ts";
import { outsidePastedText, readClipboardFormatting } from "./clipboard-formatting.ts";
import { useDraftRecord, type DraftFormatting, type DraftRecord } from "./local-drafts.ts";
import { MessageText } from "./message-text.tsx";

const labels: Record<MessageStyle, string> = {
  bold: "Bold", italic: "Italic", underline: "Underline", strike: "Strikethrough", code: "Monospace", spoiler: "Spoiler", quote: "Quote block", expandableQuote: "Collapsible quote",
};
const formats = Object.keys(labels) as MessageStyle[];
const inlineFormats = { bold: Bold, italic: Italic, underline: Underline, strike: Strikethrough };

const formattingShortcuts: Readonly<Record<string, MessageStyle | "clear">> = {
  KeyB: "bold", KeyI: "italic", KeyU: "underline", "Shift+KeyM": "code", "Shift+KeyN": "clear", "Shift+Period": "quote",
};
export const draftLinkShortcuts = "Meta+K Control+K";
export const inlineDraftFormattingShortcuts = ["B", "I", "U", "Shift+M", "Shift+N"]
  .flatMap((key) => [`Meta+${key}`, `Control+${key}`]).join(" ");
export const draftFormattingShortcuts = `${inlineDraftFormattingShortcuts} Meta+Shift+. Control+Shift+.`;

export function draftFormatFromShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey === event.metaKey
    || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  return formattingShortcuts[`${event.shiftKey ? "Shift+" : ""}${event.code}`];
}

export function useDraftFormatting(id: string, text: string, input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>, base: StyledRange[] = [], allowLinks = false, baseLinks: MessageLink[] = [], storage?: DraftRecord<DraftFormatting | undefined>, baseEmoji: CustomEmojiRange[] = []) {
  const [openId, setOpenId] = useState<string>();
  const [contextualId, setContextualId] = useState<string>();
  const [linkDraft, setLinkDraft] = useState<{ id: string; offset: number; length: number; url: string; text: string; error?: string }>();
  const [selection, setSelection] = useState<{ id: string; offset: number; length: number }>();
  const [drafts, setDrafts] = useDraftRecord(storage);
  const dismiss = useCallback(() => {
    setOpenId(undefined);
    setContextualId(undefined);
  }, []);
  const saved = drafts[id];
  const ranges = saved?.text === text ? saved.ranges : base;
  const links = saved?.text === text ? saved.links : baseLinks;
  const customEmoji = saved?.text === text ? saved.customEmoji ?? [] : baseEmoji;
  const selected = selection?.id === id ? selection : undefined;
  const open = openId === id || contextualId === id;

  function setRanges(next: StyledRange[], value = text, nextLinks = links, nextEmoji = customEmoji) {
    setDrafts((previous) => ({ ...previous, [id]: { text: value, ranges: next, links: nextLinks, ...(nextEmoji.length ? { customEmoji: nextEmoji } : {}) } }));
  }

  function nextFormat(style: MessageStyle | "clear", range = selected) {
    if (!range?.length) return;
    const { offset, length } = range;
    const end = offset + length;
    const matching = ranges.findIndex((item) => item.offset === offset && item.length === length && item.style === style);
    const next = style === "clear" ? ranges.flatMap((item) => {
      const itemEnd = item.offset + item.length;
      if (end <= item.offset || offset >= itemEnd) return [item];
      return [
        ...(item.offset < offset ? [{ ...item, length: offset - item.offset }] : []),
        ...(itemEnd > end ? [{ ...item, offset: end, length: itemEnd - end }] : []),
      ];
    }) : matching >= 0 ? ranges.filter((_, index) => index !== matching) : [
      ...ranges.filter((item) => !isQuoteStyle(style) || !isQuoteStyle(item.style) || item.offset !== offset || item.length !== length),
      { offset, length, style },
    ];
    return validDraftStyles(text, next) && validDraftLinks(text, links, next) && validDraftCustomEmoji(text, customEmoji, next, links) ? next : undefined;
  }

  function toggleFormat(style: MessageStyle | "clear", range = selected) {
    const next = nextFormat(style, range);
    if (!range || !next) return;
    setRanges(next);
    input.current?.focus();
    input.current?.setSelectionRange(range.offset, range.offset + range.length);
  }

  function openLink(range = selected) {
    if (!allowLinks || !range?.length) return;
    const { offset, length } = range;
    const existing = links.find((link) => link.offset === offset && link.length === length);
    setLinkDraft({ id, offset, length, url: existing?.url ?? "", text });
  }

  const editingLink = linkDraft?.id === id && linkDraft.text === text ? linkDraft : undefined;
  function applyLink(remove = false) {
    if (!editingLink) return;
    const { offset, length } = editingLink;
    const next = links.filter((link) => link.offset !== offset || link.length !== length);
    if (!remove) {
      const url = webLink(editingLink.url.trim())?.href;
      if (!url) {
        setLinkDraft({ ...editingLink, error: "Enter a valid HTTP or HTTPS link." });
        return;
      }
      next.push({ offset, length, url, hidden: true });
    }
    if (!validDraftLinks(text, next, ranges) || !validDraftCustomEmoji(text, customEmoji, ranges, next)) {
      setLinkDraft({ ...editingLink, error: "This link overlaps existing formatting or another link." });
      return;
    }
    setRanges(ranges, text, next.sort((a, b) => a.offset - b.offset));
    setLinkDraft(undefined);
    input.current?.focus();
    input.current?.setSelectionRange(offset, offset + length);
  }

  const deliveryLinks = trimDraftRanges(text, links).map(({ offset, length, url }) => ({ offset, length, url }));
  const deliveryStyles = trimDraftRanges(text, ranges);
  const deliveryCustomEmoji = trimDraftRanges(text, customEmoji);
  const captionFormat = captionFormatForRanges(deliveryStyles, deliveryLinks, deliveryCustomEmoji);

  return {
    text, ranges, links, customEmoji, selected, open, dismiss, toggleFormat, canToggleFormat: (style: MessageStyle) => nextFormat(style) !== undefined, allowLinks, editingLink, openLink, applyLink,
    canRemoveLink: !!editingLink && links.some((link) => link.offset === editingLink.offset && link.length === editingLink.length),
    changeLink(url: string) { if (editingLink) setLinkDraft({ ...editingLink, url, error: undefined }); },
    cancelLink() { setLinkDraft(undefined); input.current?.focus(); },
    deliveryLinks, deliveryStyles, deliveryCustomEmoji, captionFormat,
    insertCustomEmoji(choice: GroupEmojiChoice, commit: (value: string) => void) {
      const element = input.current;
      if (!element || element.disabled) return false;
      const start = element.selectionStart ?? text.length;
      const end = element.selectionEnd ?? start;
      const nextText = text.slice(0, start) + choice.emoji + text.slice(end);
      if (element.maxLength >= 0 && nextText.length > element.maxLength) return false;
      const length = choice.emoji.length;
      const nextStyles = moveRangesThroughEdit(ranges, start, end, length);
      const nextLinks = moveRangesThroughEdit(links, start, end, length);
      const nextEmoji = [...moveRangesThroughEdit(customEmoji, start, end, length, true), { id: choice.id, offset: start, length }];
      if (!validDraftStyles(nextText, nextStyles) || !validDraftLinks(nextText, nextLinks, nextStyles)
        || !validDraftCustomEmoji(nextText, nextEmoji, nextStyles, nextLinks)) return false;
      setRanges(nextStyles, nextText, nextLinks, nextEmoji);
      commit(nextText);
      const caret = start + length;
      setSelection({ id, offset: caret, length: 0 });
      element.focus();
      requestAnimationFrame(() => {
        if (element.isConnected && element.value === nextText && element.ownerDocument.activeElement === element) {
          element.setSelectionRange(caret, caret);
        }
      });
      return true;
    },
    toggle() {
      setOpenId(open ? undefined : id);
      setContextualId(undefined);
      input.current?.focus();
    },
    select(element: HTMLInputElement | HTMLTextAreaElement, contextual = false) {
      const { selectionStart, selectionEnd } = element;
      if (selectionStart !== null && selectionEnd !== null) {
        setSelection({ id, offset: selectionStart, length: selectionEnd - selectionStart });
        if (contextual) setContextualId(selectionEnd > selectionStart ? id : undefined);
      }
    },
    shortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey === event.metaKey
        || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      const { selectionStart, selectionEnd } = event.currentTarget;
      const style = draftFormatFromShortcut(event);
      const link = allowLinks && !event.shiftKey && event.code === "KeyK";
      if ((!style && !link) || selectionEnd <= selectionStart) return;
      event.preventDefault();
      if (event.repeat) return;
      const range = { id, offset: selectionStart, length: selectionEnd - selectionStart };
      setSelection(range);
      if (link) openLink(range);
      else if (style) toggleFormat(style, range);
    },
    paste(event: ClipboardEvent<HTMLTextAreaElement>, commit: (value: string) => void) {
      if (event.defaultPrevented) return;
      const element = event.currentTarget;
      const pasted = readClipboardFormatting(event.clipboardData, element.ownerDocument, element.maxLength);
      if (!pasted || (!allowLinks && !pasted.ranges.length)) return;
      const { selectionStart: start, selectionEnd: end } = element;
      const caret = start + pasted.text.length;
      const nextText = text.slice(0, start) + pasted.text + text.slice(end);
      if (element.maxLength >= 0 && nextText.length > element.maxLength) return;
      const inserted = <T extends { offset: number }>(range: T) => ({ ...range, offset: range.offset + start });
      const nextStyles = [...outsidePastedText(ranges, start, end, pasted.text.length), ...pasted.ranges.map(inserted)];
      const nextLinks = [...outsidePastedText(links, start, end, pasted.text.length), ...(allowLinks ? pasted.links.map(inserted) : [])]
        .sort((a, b) => a.offset - b.offset);
      if (!validDraftStyles(nextText, nextStyles) || !validDraftLinks(nextText, nextLinks, nextStyles)) return;
      event.preventDefault();
      const nextEmoji = moveRangesThroughEdit(customEmoji, start, end, pasted.text.length, true)
        .filter((entry) => validDraftCustomEmoji(nextText, [entry], nextStyles, nextLinks));
      setRanges(nextStyles, nextText, nextLinks, nextEmoji);
      commit(nextText);
      setSelection({ id, offset: caret, length: 0 });
      requestAnimationFrame(() => {
        if (element.isConnected && element.value === nextText && element.ownerDocument.activeElement === element) {
          element.setSelectionRange(caret, caret);
        }
      });
    },
    change(value: string, caret?: number) {
      if (ranges.length || links.length || customEmoji.length || saved?.text === text) {
        const nextStyles = moveDraftRanges(text, value, ranges);
        const nextLinks = moveDraftRanges(text, value, links);
        const nextEmoji = moveDraftRanges(text, value, customEmoji, true, caret)
          .filter((entry) => validDraftCustomEmoji(value, [entry], nextStyles, nextLinks));
        setRanges(nextStyles, value, nextLinks, nextEmoji);
      }
    },
    restore(draft: SyncedDraft) { setRanges(draft.styles ?? [], draft.text, draft.links ?? [], draft.customEmoji ?? []); },
    clear() { setRanges([]); },
    reset() {
      setDrafts((previous) => ({ ...previous, [id]: undefined }));
      setOpenId(undefined);
      setSelection(undefined);
      setLinkDraft(undefined);
    },
    clearSent(sentId: string, sentText: string, exact = false) {
      setDrafts((previous) => (exact ? previous[sentId]?.text : previous[sentId]?.text.trim()) === sentText
        ? { ...previous, [sentId]: undefined } : previous);
    },
  };
}

type Formatting = ReturnType<typeof useDraftFormatting>;

export function DraftFormatButton({ formatting, busy, floating }: { formatting: Formatting; busy: boolean; floating?: boolean }) {
  const { t: tr } = useTelegramLocale();
  return <Button type="button" variant="ghost" size={floating ? "icon" : "sm"} aria-label={tr("Format message")} data-composer-format-toggle
    aria-expanded={formatting.open} disabled={busy} onClick={formatting.toggle}><span aria-hidden="true">{tr("Aa")}</span></Button>;
}

export function DraftFormatControls({ formatting, busy, floating, previewLabel = "Formatted message preview" }: {
  formatting: Formatting; busy: boolean; floating?: boolean; previewLabel?: string;
}) {
  const { t: tr } = useTelegramLocale();
  const { open, text, ranges, selected } = formatting;
  const { offset = 0, length = 0 } = selected ?? {};
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const moreId = useId();
  const editingLink = !!formatting.editingLink;
  const dismiss = formatting.dismiss;
  useEffect(() => { if (!open) setMore(false); }, [open]);
  useEffect(() => {
    if (!floating || !open || editingLink) return;
    const panel = flyout.current;
    const form = panel?.closest("form");
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element) || panel?.contains(event.target)) return;
      const control = event.target.closest(".mtg-compose-field, [data-composer-format-toggle]");
      if (!control || !form?.contains(control)) dismiss();
    }
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [floating, open, editingLink, dismiss]);

  function formatButton(style: MessageStyle) {
    const applied = ranges.some((range) => range.offset === offset && range.length === length && range.style === style);
    const Icon = floating && style in inlineFormats ? inlineFormats[style as keyof typeof inlineFormats] : undefined;
    return <Button key={style} type="button" variant="ghost" size={Icon ? "icon" : "sm"} aria-pressed={applied}
      aria-label={tr(labels[style])} disabled={busy || !formatting.canToggleFormat(style)}
      onMouseDown={(event) => { if (floating && event.button === 0) event.preventDefault(); }}
      onClick={() => formatting.toggleFormat(style)}>{Icon ? <Icon size={16} aria-hidden="true" /> : tr(labels[style])}</Button>;
  }
  const clear = !!ranges.length && <button type="button" className="mtg-action" disabled={busy}
    onClick={formatting.clear}>{tr("Clear formatting")}</button>;
  const controls = <>
    {open && (!floating || !formatting.editingLink) && <div className="mtg-composer-format" role="group" aria-label={tr("Message formatting")} data-format-commands>
      {floating ? <>
        {!length && <span className="mtg-format-hint">{tr("Select text to format it.")}</span>}
        {length > 0 && <>
          {formats.filter((style) => style in inlineFormats).map(formatButton)}
          {formatting.allowLinks && <Button variant="ghost" size="icon" type="button" disabled={busy}
            aria-label={tr("Add or edit link")} onClick={() => formatting.openLink()}><Link2 size={17} aria-hidden="true" /></Button>}
        </>}
        {(length > 0 || clear) && <Button ref={moreButton} type="button" variant="ghost" size="icon"
          aria-label={tr("More formatting")} aria-expanded={more} aria-controls={moreId} onClick={() => setMore(!more)}>
          <Ellipsis size={18} aria-hidden="true" />
        </Button>}
        {more && (length > 0 || clear) && <div id={moreId} className="mtg-format-extra">
          {length > 0 && formats.filter((style) => !(style in inlineFormats)).map(formatButton)}
          {clear}
        </div>}
      </> : <>
      {formats.map(formatButton)}
      {clear}
      {!length && <span>{tr("Select text in your message to format it.")}</span>}
      </>}
    </div>}
    {!floating && open && formatting.allowLinks && <button type="button" className="mtg-action" disabled={busy || !length}
      onClick={() => formatting.openLink()}>{tr("Add or edit link")}</button>}
    {formatting.editingLink && <div className="mtg-composer-format" role="group" aria-label={tr("Text link")} data-format-link>
      <label>{tr("Link URL ")}<input type="url" value={formatting.editingLink.url} autoFocus maxLength={4096}
        disabled={busy} onChange={(event) => formatting.changeLink(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            if (event.key === "Enter") formatting.applyLink();
            else formatting.cancelLink();
          }
        }} /></label>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => formatting.applyLink()}>{tr("Apply link")}</button>
      {formatting.canRemoveLink && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => formatting.applyLink(true)}>{tr("Remove link")}</button>}
      <button type="button" className="mtg-action" onClick={formatting.cancelLink}>{tr("Cancel link")}</button>
      {formatting.editingLink.error && <span role="alert">{formatting.editingLink.error}</span>}
    </div>}
  </>;
  return <>
    {floating ? (open || formatting.editingLink) && <div ref={flyout} className="mtg-format-flyout" onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (formatting.editingLink) formatting.cancelLink();
      else if (more) {
        setMore(false);
        moreButton.current?.focus();
      } else formatting.toggle();
    }}>{controls}</div> : controls}
    {!!(ranges.length || formatting.links.length || formatting.customEmoji.length) && <div className="mtg-composer-format-preview" aria-label={previewLabel}>
      <MessageText text={text} styles={ranges} links={formatting.links} customEmoji={formatting.customEmoji} />
    </div>}
  </>;
}
