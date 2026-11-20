import { useTelegramLocale } from "./i18n/index.tsx";
import type { RefObject } from "react";
import type { SyncedDraft } from "../core/contract.ts";
import { validDraftLinks, validDraftStyles } from "../core/draft-formatting.ts";
import { MessageText } from "./message-text.tsx";

type LinkDraftFormatting = Pick<SyncedDraft, "styles" | "links">;
export type LinkDraft = LinkDraftFormatting & { text: string; selectionStart: number; chatId?: string; formattingReduced?: true };

export function LinkDraftInsert({ draft, currentText, currentFormatting, input, disabled, requiresRemoteDraft, insert, dismiss }: {
  draft: LinkDraft;
  currentText: string;
  currentFormatting?: LinkDraftFormatting;
  input: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  requiresRemoteDraft: boolean;
  insert: (text: string, formatting?: LinkDraftFormatting) => void;
  dismiss: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const prefix = currentText ? `${currentText}\n\n` : "";
  const nextText = prefix + draft.text;
  const tooLong = nextText.length > 4096;
  const styles = [...(currentFormatting?.styles ?? []),
    ...(draft.styles ?? []).map((range) => ({ ...range, offset: range.offset + prefix.length }))];
  const links = [...(currentFormatting?.links ?? []),
    ...(draft.links ?? []).map((link) => ({ ...link, offset: link.offset + prefix.length }))];
  const hasFormatting = !!(draft.styles?.length || draft.links?.length);
  const invalidFormatting = hasFormatting && (!validDraftStyles(nextText, styles) || !validDraftLinks(nextText, links, styles));
  return <section className="mtg-send-status" aria-label={draft.chatId ? tr("Telegram link draft") : tr("Shared link draft")}>
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      <MessageText text={draft.text} styles={draft.styles} />
    </div>
    {draft.formattingReduced && <p>{tr("Some formatting from this link is unavailable in BB.")}</p>}
    {requiresRemoteDraft && <p>{tr("Use the Telegram draft to keep its text before inserting this draft.")}</p>}
    {tooLong && <p>{tr("The combined draft exceeds the message length limit.")}</p>}
    {invalidFormatting && <p>{tr("The combined draft exceeds Telegram’s formatting limits.")}</p>}
    <button type="button" className="mtg-action" disabled={disabled || requiresRemoteDraft || tooLong || invalidFormatting} onClick={() => {
      const composer = input.current;
      insert(nextText, hasFormatting ? { styles, links } : undefined);
      dismiss();
      requestAnimationFrame(() => {
        if (!composer?.isConnected || composer.value !== nextText) return;
        composer.focus();
        composer.setSelectionRange(prefix.length + draft.selectionStart, nextText.length);
      });
    }}>{draft.chatId ? tr("Insert link draft") : tr("Insert shared link")}</button>
    <button type="button" className="mtg-action" onClick={dismiss}>{draft.chatId ? tr("Cancel link draft") : tr("Cancel share")}</button>
  </section>;
}
