import { useState } from "react";
import type { ReplyQuote } from "../core/contract.ts";

export function SelectReplyQuote({ text, quote, disabled, change }: {
  text: string;
  quote?: ReplyQuote;
  disabled: boolean;
  change: (value?: ReplyQuote) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReplyQuote>();
  if (open) return <div className="mtg-quote-picker">
    <label>Select the passage to quote
      <textarea readOnly autoFocus rows={3} value={text} onSelect={(event) => {
        const { selectionStart, selectionEnd } = event.currentTarget;
        const value = text.slice(selectionStart, selectionEnd);
        setSelected(value.trim() && value.length <= 1024 ? { text: value, position: selectionStart } : undefined);
      }} />
    </label>
    <button type="button" className="mtg-action" disabled={disabled || !selected} onClick={() => {
      change(selected);
      setSelected(undefined);
      setOpen(false);
    }}>Use selected quote</button>
    <button type="button" className="mtg-action" onClick={() => { setSelected(undefined); setOpen(false); }}>Cancel selection</button>
  </div>;

  return <button type="button" className="mtg-action" disabled={disabled}
    onClick={() => quote ? change(undefined) : setOpen(true)}>{quote ? "Remove quote" : "Choose quote"}</button>;
}
