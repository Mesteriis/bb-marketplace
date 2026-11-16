import { useState, type RefObject } from "react";
import type { MessageStyle, StyledRange } from "../core/contract.ts";
import { moveDraftStyles, trimDraftStyles, validDraftStyles } from "../core/draft-formatting.ts";
import { MessageText } from "./message-text.tsx";

const labels: Record<MessageStyle, string> = {
  bold: "Bold", italic: "Italic", underline: "Underline", strike: "Strikethrough", code: "Monospace", spoiler: "Spoiler",
};
const formats = Object.keys(labels) as MessageStyle[];

export function useDraftFormatting(id: string, text: string, input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>, base: StyledRange[] = []) {
  const [openId, setOpenId] = useState<string>();
  const [selection, setSelection] = useState<{ id: string; offset: number; length: number }>();
  const [drafts, setDrafts] = useState<Record<string, { text: string; ranges: StyledRange[] } | undefined>>({});
  const saved = drafts[id];
  const ranges = saved?.text === text ? saved.ranges : base;
  const selected = selection?.id === id ? selection : undefined;
  const open = openId === id;

  function setRanges(next: StyledRange[], value = text) {
    setDrafts((previous) => ({ ...previous, [id]: { text: value, ranges: next } }));
  }

  function toggleFormat(style: MessageStyle) {
    if (!selected?.length) return;
    const { offset, length } = selected;
    const matching = ranges.findIndex((range) => range.offset === offset && range.length === length && range.style === style);
    const next = matching >= 0 ? ranges.filter((_, index) => index !== matching) : [...ranges, { offset, length, style }];
    if (!validDraftStyles(text, next)) return;
    setRanges(next);
    input.current?.focus();
    input.current?.setSelectionRange(offset, offset + length);
  }

  return {
    text, ranges, selected, open, toggleFormat,
    deliveryStyles: trimDraftStyles(text, ranges),
    toggle() {
      setOpenId(open ? undefined : id);
      input.current?.focus();
    },
    select(element: HTMLInputElement | HTMLTextAreaElement) {
      const { selectionStart, selectionEnd } = element;
      if (selectionStart !== null && selectionEnd !== null) {
        setSelection({ id, offset: selectionStart, length: selectionEnd - selectionStart });
      }
    },
    change(value: string) {
      if (ranges.length || saved?.text === text) setRanges(moveDraftStyles(text, value, ranges), value);
    },
    clear() { setRanges([]); },
    clearSent(sentId: string, sentText: string) {
      setDrafts((previous) => previous[sentId]?.text.trim() === sentText ? { ...previous, [sentId]: undefined } : previous);
    },
  };
}

type Formatting = ReturnType<typeof useDraftFormatting>;

export function DraftFormatButton({ formatting, busy }: { formatting: Formatting; busy: boolean }) {
  return <button type="button" aria-label="Format message" title="Format message"
    aria-expanded={formatting.open} disabled={busy} onClick={formatting.toggle}><span aria-hidden="true">Aa</span></button>;
}

export function DraftFormatControls({ formatting, busy, previewLabel = "Formatted message preview" }: {
  formatting: Formatting; busy: boolean; previewLabel?: string;
}) {
  const { open, text, ranges, selected } = formatting;
  const { offset = 0, length = 0 } = selected ?? {};
  return <>
    {open && <div className="mtg-composer-format" role="group" aria-label="Message formatting">
      {formats.map((style) => {
        const applied = ranges.some((range) => range.offset === offset && range.length === length && range.style === style);
        return <button key={style} type="button" className="mtg-action" aria-pressed={applied}
          disabled={busy || !length || !applied && !validDraftStyles(text, [...ranges, { offset, length, style }])}
          onClick={() => formatting.toggleFormat(style)}>{labels[style]}</button>;
      })}
      {!!ranges.length && <button type="button" className="mtg-action" disabled={busy}
        onClick={formatting.clear}>Clear formatting</button>}
      {!length && <span>Select text in your message to format it.</span>}
    </div>}
    {!!ranges.length && <div className="mtg-composer-format-preview" aria-label={previewLabel}>
      <MessageText text={text} styles={ranges} />
    </div>}
  </>;
}
