import type { StyledRange } from "./contract.ts";

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
      if (range.style === "code" || previous.style === "code" || range.style === previous.style) return false;
      return range.offset >= previous.offset && end <= previousEnd
        || previous.offset >= range.offset && previousEnd <= end;
    });
  });
}

export function sameDraftStyles(first: readonly StyledRange[], second: readonly StyledRange[]): boolean {
  const signature = (ranges: readonly StyledRange[]) => ranges
    .map(({ offset, length, style }) => `${offset}:${length}:${style}`).sort().join("|");
  return first.length === second.length && signature(first) === signature(second);
}

export function trimDraftStyles(text: string, ranges: readonly StyledRange[]): StyledRange[] {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return ranges.flatMap((range) => {
    const left = Math.max(start, range.offset);
    const right = Math.min(end, range.offset + range.length);
    return right > left ? [{ ...range, offset: left - start, length: right - left }] : [];
  });
}

export function moveDraftStyles(before: string, after: string, ranges: readonly StyledRange[]): StyledRange[] {
  if (!ranges.length || before === after) return [...ranges];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return ranges.flatMap((range) => {
    const finish = range.offset + range.length;
    if (finish <= start) return [range];
    if (range.offset >= end) return [{ ...range, offset: range.offset + nextEnd - end }];
    const containsEdit = range.offset <= start && finish >= end;
    const left = Math.max(0, start - range.offset);
    const right = Math.max(0, finish - end);
    const length = left + right + (containsEdit ? nextEnd - start : 0);
    const offset = left ? range.offset : containsEdit ? start : nextEnd;
    return length > 0 ? [{ ...range, offset, length }] : [];
  });
}
