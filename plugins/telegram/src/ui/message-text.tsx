import { useTelegramLocale } from "./i18n/index.tsx";
import { canonicalTelegramContentLink } from "../core/telegram-content-link.ts";
import { createContext, Fragment, useContext, useState, type ReactNode } from "react";
import type { CustomEmojiRange, ReplyQuoteAnchor, RichStyledRange } from "../core/contract.ts";
import { isQuoteStyle } from "../core/draft-formatting.ts";
import { spoilerRanges } from "../core/message-spoilers.ts";
import { OpenTelegramMessageLink, TelegramMessageLink } from "./telegram-message-link.tsx";
import { articleContactLink, webLink, type MessageLink } from "../core/message-links.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import { MessageEmojiStatusTarget } from "./message-emoji-status.tsx";

export const MessageSearchQuery = createContext<string | undefined>(undefined);
export const MessageQuoteFocus = createContext<{ id: string; quote: ReplyQuoteAnchor } | undefined>(undefined);

type TextMatch = { start: number; end: number; quote?: true };

function searchMatches(text: string, query: string | undefined) {
  const input = query?.slice(0, 128).trim();
  if (!input) return [];
  const terms = [...new Set(input.split(/\s+/u))].sort((a, b) => b.length - a.length);
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const ranges: TextMatch[] = [];
  for (const hit of text.matchAll(new RegExp(pattern, "giu"))) {
    ranges.push({ start: hit.index, end: hit.index + hit[0].length });
    if (ranges.length === 256) break;
  }
  return ranges;
}

function highlightMatches(text: string, start: number, end: number, matches: ReturnType<typeof searchMatches>) {
  let cursor = start;
  const parts = matches.flatMap((match) => {
    const left = Math.max(start, match.start);
    const right = Math.min(end, match.end);
    if (left >= right) return [];
    const value = text.slice(left, right);
    const part = <Fragment key={left}>{text.slice(cursor, left)}{match.quote
      ? <mark className="mtg-search-match" data-reply-quote-match>{value}</mark>
      : <span className="mtg-search-match">{value}</span>}</Fragment>;
    cursor = right;
    return [part];
  });
  return parts.length ? <>{parts}{text.slice(cursor, end)}</> : text.slice(start, end);
}

export function MessageSearchLabel({ text }: { text: string }) {
  const query = useContext(MessageSearchQuery);
  return highlightMatches(text, 0, text.length, searchMatches(text, query));
}

export function MessageText({ text, links = [], styles = [], customEmoji = [], inline = false, renderLink, replacements = [], allowContactLinks = false, onRevealSpoiler, quoteSource, quoteRange, quoteSelection, emojiStatusActions }: {
  text: string | undefined;
  links?: readonly MessageLink[];
  styles?: readonly RichStyledRange[];
  customEmoji?: readonly CustomEmojiRange[];
  inline?: boolean;
  quoteSource?: string;
  quoteRange?: { start: number; end: number };
  quoteSelection?: boolean;
  emojiStatusActions?: boolean;
  renderLink?: (url: URL, label: ReactNode, link: MessageLink) => ReactNode;
  allowContactLinks?: boolean;
  replacements?: readonly { offset: number; length: number; content: ReactNode | ((label: ReactNode) => ReactNode) }[];
  onRevealSpoiler?: (range: { start: number; end: number }) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const openTelegram = useContext(OpenTelegramMessageLink);
  const loadEmoji = useContext(CustomEmojiLoader);
  const searchQuery = useContext(MessageSearchQuery);
  const quoteFocus = useContext(MessageQuoteFocus);
  const [revealed, setRevealed] = useState<{ text: string; ranges: ReadonlySet<string> }>();
  if (!text) return null;
  const validStyles = styles.filter(({ offset, length }) => Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length > 0 && offset + length <= text.length);
  const inlineStyles = validStyles.filter(({ style }) => style !== "spoiler" && !isQuoteStyle(style));
  const quote = quoteFocus?.id === quoteSource && !quoteFocus?.quote.rich ? quoteFocus?.quote : undefined;
  const quoteEnd = quote ? quote.position + quote.text.length : 0;
  const matches: TextMatch[] = quoteRange ? [{ ...quoteRange, quote: true }]
    : quote && text.slice(quote.position, quoteEnd) === quote.text
    ? [{ start: quote.position, end: quoteEnd, quote: true }] : searchMatches(text, searchQuery);
  const inlineElements = [
    ...replacements,
    ...(loadEmoji ? customEmoji.map(({ id, offset, length }) => {
      const label = text.slice(offset, offset + length);
      const image = <InlineCustomEmoji id={id} label={label} load={loadEmoji} />;
      const linked = links.some((link) => link.offset < offset + length && link.offset + link.length > offset);
      return { offset, length, content: emojiStatusActions && !linked
        ? <MessageEmojiStatusTarget emoji={id} label={label}>{image}</MessageEmojiStatusTarget> : image };
    }) : []),
  ].sort((a, b) => a.offset - b.offset);

  function renderInline(value: string, start: number, end: number) {
    let cursor = start;
    const parts = inlineElements.flatMap(({ offset, length, content }) => {
      const right = offset + length;
      if (offset < cursor || length < 1 || right > end) return [];
      const artwork = typeof content === "function" ? content(renderStyled(value, inlineStyles, offset, right, matches)) : content;
      const element = quoteSelection ? <span data-reply-rich-atom={length}>{artwork}</span> : artwork;
      const quoted = typeof content !== "function"
        && matches.some((match) => match.quote && match.start <= offset && right <= match.end);
      const result = <Fragment key={offset}>
        {renderStyled(value, inlineStyles, cursor, offset, matches)}
        {quoted ? <mark className="mtg-search-match" data-reply-quote-match>{element}</mark> : element}
      </Fragment>;
      cursor = right;
      return [result];
    });
    return <>{parts}{renderStyled(value, inlineStyles, cursor, end, matches)}</>;
  }

  function renderContent(value: string, start: number, end: number) {
    let cursor = start;
    const parts = links.flatMap((link) => {
      const { offset, length, url, hidden } = link;
      const telegram = canonicalTelegramContentLink(url);
      const contact = allowContactLinks && !hidden ? articleContactLink(url) : undefined;
      const target = contact ?? webLink(url) ?? (telegram ? webLink(telegram) : undefined);
      const right = offset + length;
      if (!target || offset < cursor || length < 1 || right > end) return [];
      const label = renderInline(value, offset, right);
      const part = <Fragment key={offset}>
        {renderInline(value, cursor, offset)}
        {contact ? <a href={contact.href}>{label}</a> :
          (hidden ? undefined : renderLink?.(target, label, link)) ?? (telegram && openTelegram ? <TelegramMessageLink url={telegram} follow={openTelegram}>{label}</TelegramMessageLink> : hidden
          ? <button type="button" className="mtg-hidden-link" onClick={() => {
            if (window.confirm(tr("Open this link?\n\n{0}", [target.href]))) window.open(target.href, "_blank", "noopener,noreferrer");
          }}>{label}</button>
          : <a href={target.href} target="_blank" rel="noopener noreferrer">{label}</a>)}
      </Fragment>;
      cursor = right;
      return [part];
    });
    return <>{parts}{renderInline(value, cursor, end)}</>;
  }

  const content = text;
  const spoilers = spoilerRanges(content, styles);
  function renderRange(start: number, end: number) {
    let cursor = start;
    const parts = spoilers.flatMap((range) => {
      const left = Math.max(start, range.start);
      const right = Math.min(end, range.end);
      const key = `${range.start}:${range.end}`;
      if (left >= right || (revealed?.text === content && revealed.ranges.has(key))) return [];
      const part = <Fragment key={key}>
        {renderContent(content, cursor, left)}
        <button type="button" className="mtg-spoiler" data-reply-rich-atom={quoteSelection ? right - left : undefined} onClick={() => {
          setRevealed((previous) => ({
            text: content,
            ranges: new Set([...(previous?.text === content ? previous.ranges : []), key]),
          }));
          onRevealSpoiler?.(range);
        }}>{tr("Show spoiler")}</button>
      </Fragment>;
      cursor = right;
      return [part];
    });
    return <>{parts}{renderContent(content, cursor, end)}</>;
  }

  if (inline) return renderRange(0, text.length);
  const quotes = validStyles.filter(({ style }) => isQuoteStyle(style)).sort((a, b) => a.offset - b.offset);
  if (!quotes.length) return <p data-reply-quote-source={quoteSource}>{renderRange(0, text.length)}</p>;
  let cursor = 0;
  const blocks = quotes.flatMap(({ offset, length, style }) => {
    if (offset < cursor) return [];
    const part = <Fragment key={offset}>
      {cursor < offset && <p>{renderRange(cursor, offset)}</p>}
      {style === "expandableQuote"
        ? <ExpandableQuote key={text.slice(offset, offset + length)}>{renderRange(offset, offset + length)}</ExpandableQuote>
        : <blockquote className="mtg-text-quote">{renderRange(offset, offset + length)}</blockquote>}
    </Fragment>;
    cursor = offset + length;
    return [part];
  });
  return <div className="mtg-quoted-text" data-reply-quote-source={quoteSource}>{blocks}{cursor < text.length && <p>{renderRange(cursor, text.length)}</p>}</div>;
}

export function ExpandableQuote({ children, initiallyOpen = false }: { children: ReactNode; initiallyOpen?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="mtg-expandable-quote" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{open ? tr("Collapse quote") : tr("Show quote")}</summary>
    {open && <blockquote className="mtg-text-quote">{children}</blockquote>}
  </details>;
}

function renderStyled(text: string, styles: readonly RichStyledRange[], start: number, end: number, matches: ReturnType<typeof searchMatches>) {
  const overlaps = styles.filter(({ offset, length }) => offset < end && offset + length > start);
  if (!overlaps.length) return highlightMatches(text, start, end, matches);

  const boundaries = new Set([start, end]);
  for (const { offset, length } of overlaps) {
    boundaries.add(Math.max(start, offset));
    boundaries.add(Math.min(end, offset + length));
  }
  const positions = [...boundaries].sort((a, b) => a - b);
  return positions.slice(0, -1).map((left, index) => {
    const value = highlightMatches(text, left, positions[index + 1]!, matches);
    const active = new Set(overlaps.filter(({ offset, length }) => offset <= left && left < offset + length)
      .map(({ style }) => style));
    let content: ReactNode = value;
    if (active.delete("subscript")) content = <sub>{content}</sub>;
    if (active.delete("superscript")) content = <sup>{content}</sup>;
    if (active.delete("marked")) content = <mark className="mtg-text-marked">{content}</mark>;
    if (active.size) content = <span className={[...active].map((style) => `mtg-text-${style}`).join(" ")}>{content}</span>;
    return <Fragment key={left}>{content}</Fragment>;
  });
}
