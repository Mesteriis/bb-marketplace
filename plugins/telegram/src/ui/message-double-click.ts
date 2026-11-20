import type { MouseEvent } from "react";

export type MessageDoubleClick = "reply" | "reaction" | "off";

export function handleMessageDoubleClick(event: MouseEvent<HTMLOListElement>, action: MessageDoubleClick) {
  const { target, currentTarget: list } = event;
  if (action === "off" || event.defaultPrevented || event.button !== 0
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || list.hidden || !(target instanceof Element)) return;
  const row = target.closest(".mtg-message[data-message-id]");
  if (!row || !list.contains(row) || target.closest("button, a, input, label, select, textarea, [contenteditable], [role=button]")) return;
  if (target !== row && !target.matches(".mtg-bubble") && !target.closest(".mtg-message-time")) return;
  if (list.ownerDocument.getSelection()?.toString()) return;
  const button = row.querySelector<HTMLButtonElement>(action === "reply"
    ? "button[data-swipe-reply]:enabled" : "button[data-quick-reaction]:enabled");
  if (!button) return;
  event.preventDefault();
  button.click();
}
