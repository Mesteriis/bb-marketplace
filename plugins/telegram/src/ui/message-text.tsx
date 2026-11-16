import { Fragment, useState } from "react";
import type { StyledRange } from "../core/contract.ts";
import { spoilerRanges } from "../core/message-spoilers.ts";
import { webLink, type MessageLink } from "../core/message-links.ts";

export function MessageText({ text, links = [], styles = [] }: {
  text: string | undefined;
  links?: readonly MessageLink[];
  styles?: readonly StyledRange[];
}) {
  const [revealed, setRevealed] = useState<{ text: string; ranges: ReadonlySet<string> }>();
  if (!text) return null;
  const validStyles = styles.filter(({ style, offset, length }) => style !== "spoiler"
    && Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length > 0 && offset + length <= text.length);

  function renderContent(value: string, start: number, end: number) {
    let cursor = start;
    const parts = links.flatMap(({ offset, length, url, hidden }) => {
      const target = webLink(url);
      const right = offset + length;
      if (!target || offset < cursor || length < 1 || right > end) return [];
      const label = renderStyled(value, validStyles, offset, right);
      const part = <Fragment key={offset}>
        {renderStyled(value, validStyles, cursor, offset)}
        {hidden
          ? <button type="button" className="mtg-hidden-link" onClick={() => {
            if (window.confirm(`Open this link?\n\n${target.href}`)) window.open(target.href, "_blank", "noopener,noreferrer");
          }}>{label}</button>
          : <a href={target.href} target="_blank" rel="noopener noreferrer">{label}</a>}
      </Fragment>;
      cursor = right;
      return [part];
    });
    return <>{parts}{renderStyled(value, validStyles, cursor, end)}</>;
  }

  let cursor = 0;
  const parts = spoilerRanges(text, styles).flatMap(({ start, end }) => {
    const key = `${start}:${end}`;
    if (revealed?.text === text && revealed.ranges.has(key)) return [];
    const part = <Fragment key={key}>
      {renderContent(text, cursor, start)}
      <button type="button" className="mtg-spoiler" onClick={() => setRevealed((previous) => ({
        text,
        ranges: new Set([...(previous?.text === text ? previous.ranges : []), key]),
      }))}>Show spoiler</button>
    </Fragment>;
    cursor = end;
    return [part];
  });
  return <p>{parts}{renderContent(text, cursor, text.length)}</p>;
}

function renderStyled(text: string, styles: readonly StyledRange[], start: number, end: number) {
  const overlaps = styles.filter(({ offset, length }) => offset < end && offset + length > start);
  if (!overlaps.length) return text.slice(start, end);

  const boundaries = new Set([start, end]);
  for (const { offset, length } of overlaps) {
    boundaries.add(Math.max(start, offset));
    boundaries.add(Math.min(end, offset + length));
  }
  const positions = [...boundaries].sort((a, b) => a - b);
  return positions.slice(0, -1).map((left, index) => {
    const value = text.slice(left, positions[index + 1]);
    const active = new Set(overlaps.filter(({ offset, length }) => offset <= left && left < offset + length)
      .map(({ style }) => style));
    return active.size
      ? <span key={left} className={[...active].map((style) => `mtg-text-${style}`).join(" ")}>{value}</span>
      : value;
  });
}
