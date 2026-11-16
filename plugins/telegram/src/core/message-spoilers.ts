import type { StyledRange } from "./contract.ts";
import type { Message } from "./demo.ts";

export function spoilerRanges(text: string, styles: readonly StyledRange[] = []) {
  const ranges = styles
    .filter(({ style, offset, length }) => style === "spoiler" && Number.isSafeInteger(offset)
      && Number.isSafeInteger(length) && offset >= 0 && offset < text.length && length > 0)
    .map(({ offset, length }) => ({ start: offset, end: Math.min(text.length, offset + length) }))
    .sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

export function previewMessageText(message?: Message) {
  if (!message) return undefined;
  const { text, styles } = message;
  let cursor = 0;
  const preview = spoilerRanges(text, styles).map(({ start, end }) => {
    const part = text.slice(cursor, start) + "[Spoiler]";
    cursor = end;
    return part;
  });
  return preview.join("") + text.slice(cursor);
}
