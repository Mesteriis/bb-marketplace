// Quoted text in a plain-text body (slice 3h, #54): the ranges the reading
// pane folds behind "Show quoted text". The rules are stripQuoted's
// (ai-input.ts): lines starting with ">" and the "On ... wrote:" line above
// them, plus Outlook's "-----Original Message-----" line and its
// From/Sent header block, each of which hides everything after it. Nothing
// is hidden when the whole body would be (a forwarded message).
// isAttribution lives here (ai-input.ts re-exports it), so the reading pane
// can use these rules without pulling the AI input module into the page.

/** The Russian forms of "wrote:" (masculine, feminine, either). */
const WROTE_RU = ["\u043d\u0430\u043f\u0438\u0441\u0430\u043b:", "\u043d\u0430\u043f\u0438\u0441\u0430\u043b\u0430:", "\u043d\u0430\u043f\u0438\u0441\u0430\u043b(\u0430):"];

/** An "On ... wrote:" line, English or Russian (also read by ai-input.ts). */
export function isAttribution(line: string): boolean {
  const text = line.trim();
  return text.endsWith(WROTE) || WROTE_RU.some((suffix) => text.endsWith(suffix));
}

export type QuoteRange = { start: number; end: number };

type Line = { text: string; start: number; end: number };

const ORIGINAL_MESSAGE =
  /^-{2,}\s*(?:original message|\u0438\u0441\u0445\u043e\u0434\u043d\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435)\s*-{2,}$/i;
const HEADER_FROM = /^(?:from|\u043e\u0442):\s/i;
const HEADER_SENT = /^(?:sent|\u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e):\s/i;
const WROTE = "wrote:";

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ text: text.slice(start, end).replace(/\r?\n$/, ""), start, end });
    start = end;
  }
  return lines;
}

const blank = (line: Line) => line.text.trim() === "";
const quoted = (line: Line) => line.text.trimStart().startsWith(">");

/** The line where an Outlook block starts, or -1. */
function outlookStart(lines: Line[]): number {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text.trim();
    if (ORIGINAL_MESSAGE.test(text)) return i;
    if (HEADER_FROM.test(text)) {
      for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
        if (HEADER_SENT.test(lines[k]!.text.trim())) return i;
      }
    }
  }
  return -1;
}

/** The quoted ranges of `text`, in order; empty when nothing (or everything) is quoted. */
export function quoteRanges(text: string): QuoteRange[] {
  const lines = splitLines(text);
  const hidden = lines.map(quoted);
  const outlook = outlookStart(lines);
  if (outlook !== -1) for (let i = outlook; i < lines.length; i++) hidden[i] = true;

  const nextNonBlank = (from: number) => {
    let k = from;
    while (k < lines.length && blank(lines[k]!)) k++;
    return k;
  };
  // An attribution goes with the quote below it, or when nothing follows it.
  for (let i = 0; i < lines.length; i++) {
    if (hidden[i] || !isAttribution(lines[i]!.text)) continue;
    const next = nextNonBlank(i + 1);
    if (next < lines.length && !hidden[next]) continue;
    for (let k = i; k < next; k++) hidden[k] = true;
    const line = lines[i]!.text.trim();
    if (!line.startsWith("On ") && line.endsWith(WROTE) && i > 0 && lines[i - 1]!.text.trim().startsWith("On ")) {
      hidden[i - 1] = true;
    }
  }
  // Blank lines between two hidden lines are hidden too.
  let lastHidden = -1;
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    if (hidden[i] && lastHidden !== -1 && lastHidden < i - 1 && hidden[lastHidden]) {
      for (let k = lastHidden + 1; k < i; k++) hidden[k] = true;
    }
    lastHidden = i;
  }

  if (!lines.some((line, i) => !hidden[i] && !blank(line))) return [];
  const ranges: QuoteRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!hidden[i]) continue;
    const start = lines[i]!.start;
    while (i + 1 < lines.length && hidden[i + 1]) i++;
    ranges.push({ start, end: lines[i]!.end });
  }
  return ranges;
}
