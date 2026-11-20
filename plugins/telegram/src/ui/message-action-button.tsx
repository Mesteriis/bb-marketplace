import { useTelegramLocale } from "./i18n/index.tsx";
import { useState, type ComponentProps } from "react";
import type { ArticleButton } from "../core/contract.ts";
import { maskSpoilers, spoilerRanges } from "../core/message-spoilers.ts";
import { inlineFormulaReplacements } from "./math-formula.tsx";
import { MessageText } from "./message-text.tsx";

type Label = Pick<Extract<ArticleButton, { kind: "url" }>, "label" | "labelFormat">;

export function buttonLabel({ label, labelFormat }: Label) {
  return spoilerRanges(label, labelFormat?.styles).length ? { text: maskSpoilers(label, labelFormat?.styles) }
    : { text: label, styles: labelFormat?.styles, customEmoji: labelFormat?.customEmoji,
      replacements: inlineFormulaReplacements(label, labelFormat?.formulas) };
}

export function CopyTextAction({ button, disabledReason }: {
  button: Label & { text: string | (() => string); style?: Extract<ArticleButton, { kind: "copy" }>["style"] };
  disabledReason?: string;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState("");
  async function copy() {
    if (disabledReason) return;
    try {
      await navigator.clipboard.writeText(typeof button.text === "function" ? button.text() : button.text);
      setStatus("Copied.");
    } catch {
      setStatus("Could not copy.");
    }
  }
  return <>
    <button type="button" className="mtg-action mtg-copy-action" data-button-style={button.style}
      disabled={!!disabledReason} title={disabledReason} onClick={() => void copy()}><MessageText {...buttonLabel(button)} inline /></button>
    {status && <span role="status">{tr(status)}</span>}
  </>;
}

export function LinkAction({ button, renderLink }: {
  button: Extract<ArticleButton, { kind: "url" }>;
  renderLink?: ComponentProps<typeof MessageText>["renderLink"];
}) {
  const label = buttonLabel(button);
  return <span className="mtg-action mtg-link-action" data-button-style={button.style}>
    <MessageText {...label}
      links={[{ offset: 0, length: label.text.length, url: button.url, hidden: !renderLink }]} renderLink={renderLink} inline />
    <span className="mtg-action-destination" aria-hidden="true"><bdi dir="ltr">{button.url}</bdi></span>
  </span>;
}
