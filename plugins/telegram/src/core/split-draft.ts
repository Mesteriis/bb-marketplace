import { maxTelegramTextLength, type CaptionFormat, type SendResult } from "./contract.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clipFormat(format: CaptionFormat | undefined, start: number, end: number): CaptionFormat {
  const clip = <T extends { offset: number; length: number }>(ranges: T[] | undefined, atomic = false) => ranges?.flatMap((range) => {
    const left = Math.max(start, range.offset);
    const right = Math.min(end, range.offset + range.length);
    return left < right && (!atomic || right - left === range.length)
      ? [{ ...range, offset: left - start, length: right - left }] : [];
  });
  return { styles: clip(format?.styles), links: clip(format?.links), customEmoji: clip(format?.customEmoji, true) };
}

export async function sendSplitDraft(source: string, format: CaptionFormat | undefined,
  active: () => boolean, send: (text: string, format: CaptionFormat, first: boolean) => Promise<SendResult>,
  accepted: (message: Extract<SendResult, { state: "sent" }>["message"]) => void) {
  const text = source.trim();
  const segments = graphemes.segment(text);
  let from = 0;
  let status: "failed" | "unknown" | undefined;
  while (from < text.length && active()) {
    let end = Math.min(text.length, from + maxTelegramTextLength);
    if (end < text.length) {
      const crossing = segments.containing(end);
      if (crossing && crossing.index > from) end = crossing.index;
      if (text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
      const tail = text.slice(from + Math.floor((end - from) / 2), end);
      const whitespace = [...tail.matchAll(/\s+/gu)].at(-1);
      if (whitespace?.index !== undefined) end = end - tail.length + whitespace.index + whitespace[0].length;
    }
    const part = text.slice(from, end).trimEnd();
    const result = await Promise.resolve().then(() => send(part, clipFormat(format, from, from + part.length), from === 0))
      .catch(() => ({ state: "unknown" as const }));
    if (result.state !== "sent") { status = result.state; break; }
    accepted(result.message);
    from = end;
    while (from < text.length && /\s/u.test(text[from]!)) from++;
  }
  return { remaining: from === 0 ? source : text.slice(from), format: clipFormat(format, from, text.length), sentAny: from > 0, status };
}
