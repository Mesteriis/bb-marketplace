import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReplyQuote, RichMessageLayout } from "../core/contract.ts";
import { richQuoteRanges, richQuoteText } from "../core/rich-message-text.ts";
import { isModifiedEnter, isPlainKey } from "./composer-keys.ts";

export function SelectReplyQuote({ text, layout, quote, disabled, change }: {
  text: string;
  layout?: RichMessageLayout;
  quote?: ReplyQuote;
  disabled: boolean;
  change: (value?: ReplyQuote) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReplyQuote>();
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (open || !restoreFocus.current) return;
    restoreFocus.current = false;
    trigger.current?.focus();
  }, [open]);

  function close() {
    restoreFocus.current = true;
    setSelected(undefined);
    setOpen(false);
  }

  function accept(value: ReplyQuote | undefined) {
    if (disabled || !value) return;
    change(value);
    close();
  }

  function selection(field: HTMLTextAreaElement): ReplyQuote | undefined {
    const { selectionStart, selectionEnd } = field;
    const value = source.slice(selectionStart, selectionEnd);
    if (!value.trim() || value.length > 1024) return;
    if (layout) {
      const quote = { text: value, position: selectionStart, rich: true as const };
      if (richQuoteRanges(layout, quote)) return quote;
    } else if (selectionStart <= 4095) return { text: value, position: selectionStart };
  }

  const source = layout ? richQuoteText(layout) : text;
  if (open) return <div className="mtg-quote-picker">
    <label>{tr("Select the passage to quote")}<textarea readOnly autoFocus rows={3} value={source} aria-keyshortcuts="Control+Enter Meta+Enter Escape"
        onSelect={(event) => setSelected(selection(event.currentTarget))}
        onKeyDown={(event) => {
          if (isPlainKey(event, "Escape")) {
            event.preventDefault();
            close();
          } else if (isModifiedEnter(event)) {
            event.preventDefault();
            accept(selection(event.currentTarget));
          }
        }} />
    </label>
    <button type="button" className="mtg-action" disabled={disabled || !selected}
      onClick={() => accept(selected)}>{tr("Use selected quote")}</button>
    <button type="button" className="mtg-action" onClick={close}>{tr("Cancel selection")}</button>
  </div>;

  return <button ref={trigger} type="button" className="mtg-action" disabled={disabled}
    onClick={() => quote ? change(undefined) : setOpen(true)}>{quote ? tr("Remove quote") : tr("Choose quote")}</button>;
}
