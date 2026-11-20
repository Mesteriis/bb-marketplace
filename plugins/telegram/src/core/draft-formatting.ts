import { customEmojiId, type CaptionFormat, type CustomEmojiRange, type DraftPreview, type MessageStyle, type StyledRange } from "./contract.ts";
import { webLink, type MessageLink } from "./message-links.ts";

export function isQuoteStyle(style: string) {
  return style === "quote" || style === "expandableQuote";
}

export function validDraftStyles(text: string, ranges: readonly StyledRange[]): boolean {
  const boundary = (index: number) => index === 0 || index === text.length
    || !/[\uDC00-\uDFFF]/.test(text.charAt(index));
  return ranges.length <= 128 && ranges.every((range, index) => {
    const end = range.offset + range.length;
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0
      || range.length <= 0 || end > text.length || !boundary(range.offset) || !boundary(end)) return false;
    return ranges.slice(0, index).every((previous) => {
      const previousEnd = previous.offset + previous.length;
      if (end <= previous.offset || previousEnd <= range.offset) return true;
      if (range.style === "code" || previous.style === "code" || range.style === previous.style
        || (isQuoteStyle(range.style) && isQuoteStyle(previous.style))) return false;
      return range.offset >= previous.offset && end <= previousEnd
        || previous.offset >= range.offset && previousEnd <= end;
    });
  });
}

export function validDraftLinks(text: string, links: readonly MessageLink[], styles: readonly StyledRange[]): boolean {
  const boundary = (index: number) => index === 0 || index === text.length || !/[\uDC00-\uDFFF]/.test(text.charAt(index));
  if (links.length + styles.length > 128) return false;
  const sorted = [...links].sort((a, b) => a.offset - b.offset);
  return sorted.every((link, index) => {
    const end = link.offset + link.length;
    const previous = sorted[index - 1];
    if (!Number.isSafeInteger(link.offset) || !Number.isSafeInteger(link.length) || link.offset < 0 || link.length <= 0
      || end > text.length || !boundary(link.offset) || !boundary(end) || !webLink(link.url)
      || (previous && previous.offset + previous.length > link.offset)) return false;
    return styles.every((style) => {
      const styleEnd = style.offset + style.length;
      if (end <= style.offset || styleEnd <= link.offset) return true;
      return style.style !== "code" && (
        link.offset >= style.offset && end <= styleEnd || style.offset >= link.offset && styleEnd <= end
      );
    });
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isCustomEmojiLabel(label: string) {
  return label.length <= 32 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(label)
    && [...graphemes.segment(label)].length === 1;
}

export function validDraftCustomEmoji(text: string, entries: readonly CustomEmojiRange[],
  styles: readonly StyledRange[], links: readonly MessageLink[]): boolean {
  if (entries.length + styles.length + links.length > 128) return false;
  if (!entries.length) return true;
  const segments = graphemes.segment(text);
  const otherRanges = [...styles, ...links];
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  return sorted.every(({ id, offset, length }, index) => {
    const end = offset + length;
    const previous = sorted[index - 1];
    const segment = segments.containing(offset);
    return customEmojiId.safeParse(id).success && Number.isSafeInteger(offset) && offset >= 0
      && Number.isSafeInteger(length) && length > 0 && end <= text.length
      && isCustomEmojiLabel(text.slice(offset, end))
      && segment?.index === offset && segment.segment.length === length
      && (!previous || previous.offset + previous.length <= offset)
      && otherRanges.every((range) => {
        const rangeEnd = range.offset + range.length;
        if (end <= range.offset || rangeEnd <= offset) return true;
        return (!("style" in range) || range.style !== "code") && range.offset <= offset && end <= rangeEnd;
      });
  });
}

export function sameDraftCustomEmoji(first: readonly CustomEmojiRange[], second: readonly CustomEmojiRange[]) {
  const signature = (items: readonly CustomEmojiRange[]) => items.map(({ id, offset, length }) => `${offset}:${length}:${id}`).sort().join("|");
  return first.length === second.length && signature(first) === signature(second);
}

export function sameDraftLinks(first: readonly MessageLink[], second: readonly MessageLink[]): boolean {
  const signature = (links: readonly MessageLink[]) => JSON.stringify([...links]
    .sort((a, b) => a.offset - b.offset || a.length - b.length || a.url.localeCompare(b.url))
    .map(({ offset, length, url }) => [offset, length, url]));
  return first.length === second.length && signature(first) === signature(second);
}

export function sameDraftStyles(first: readonly StyledRange[], second: readonly StyledRange[]): boolean {
  const signature = (ranges: readonly StyledRange[]) => ranges
    .map(({ offset, length, style }) => `${offset}:${length}:${style}`).sort().join("|");
  return first.length === second.length && signature(first) === signature(second);
}

export function trimDraftRanges<T extends { offset: number; length: number }>(text: string, ranges: readonly T[]): T[] {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return ranges.flatMap((range) => {
    const left = Math.max(start, range.offset);
    const right = Math.min(end, range.offset + range.length);
    return right > left ? [{ ...range, offset: left - start, length: right - left }] : [];
  });
}

export function captionFormatForRanges(
  styles: NonNullable<CaptionFormat["styles"]>, links: NonNullable<CaptionFormat["links"]>,
  emoji: NonNullable<CaptionFormat["customEmoji"]>,
): CaptionFormat | undefined {
  return styles.length || links.length || emoji.length ? {
    ...(styles.length ? { styles } : {}),
    ...(links.length ? { links } : {}),
    ...(emoji.length ? { customEmoji: emoji } : {}),
  } : undefined;
}

export function moveDraftRanges<T extends { offset: number; length: number }>(
  before: string, after: string, ranges: readonly T[], atomic = false, caret?: number,
): T[] {
  if (!ranges.length || before === after) return [...ranges];
  // When the browser supplies a caret, anchor the edit to it if the suffix still matches.
  // This distinguishes identical adjacent emoji after a deletion or insertion.
  const candidateEnd = caret === undefined ? -1 : before.length - (after.length - caret);
  const anchor = caret !== undefined && candidateEnd >= 0 && before.slice(candidateEnd) === after.slice(caret)
    ? Math.min(caret, candidateEnd) : Math.min(before.length, after.length);
  let start = 0;
  while (start < anchor && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return moveRangesThroughEdit(ranges, start, end, nextEnd - start, atomic);
}

export function moveRangesThroughEdit<T extends { offset: number; length: number }>(
  ranges: readonly T[], start: number, end: number, insertedLength: number, atomic = false,
): T[] {
  const nextEnd = start + insertedLength;
  return ranges.flatMap((range) => {
    const finish = range.offset + range.length;
    if (finish <= start) return [range];
    if (range.offset >= end) return [{ ...range, offset: range.offset + nextEnd - end }];
    if (atomic) return [];
    const containsEdit = range.offset <= start && finish >= end;
    const left = Math.max(0, start - range.offset);
    const right = Math.max(0, finish - end);
    const length = left + right + (containsEdit ? nextEnd - start : 0);
    const offset = left ? range.offset : containsEdit ? start : nextEnd;
    return length > 0 ? [{ ...range, offset, length }] : [];
  });
}

export function sameDraftPreview(first?: DraftPreview, second?: DraftPreview): boolean {
  if (first?.mode === "disabled" || second?.mode === "disabled") return first?.mode === second?.mode;
  return first?.above === second?.above && first?.url === second?.url;
}
