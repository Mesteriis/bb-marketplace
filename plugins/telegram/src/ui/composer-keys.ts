import type { KeyboardEvent } from "react";

export function isPlainKey(event: KeyboardEvent, key: string) {
  return !event.defaultPrevented && !event.repeat && event.key === key && !event.shiftKey && !event.altKey
    && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

export function moveListFocus(event: KeyboardEvent<HTMLElement>, search: HTMLInputElement | null, rowSelector: string) {
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return false;
  const searchInput = search?.disabled ? null : search;
  const fromSearch = target === searchInput;
  const row = target.closest<HTMLButtonElement>(rowSelector);
  if (!fromSearch && !row) return false;
  const down = isPlainKey(event, "ArrowDown");
  const up = !fromSearch && isPlainKey(event, "ArrowUp");
  const home = !fromSearch && isPlainKey(event, "Home");
  const end = !fromSearch && isPlainKey(event, "End");
  const escape = !fromSearch && isPlainKey(event, "Escape");
  if (!down && !up && !home && !end && !escape) return false;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(rowSelector));
  const index = row ? rows.indexOf(row) : -1;
  const next = escape || (up && index === 0) ? searchInput : home ? rows[0] : end ? rows.at(-1) : rows[index + (down ? 1 : -1)];
  if (!next) return false;
  event.preventDefault();
  next.focus({ preventScroll: true });
  if (next !== search) next.scrollIntoView?.({ block: "nearest" });
  return true;
}

export function isModifiedEnter(event: KeyboardEvent) {
  return !event.defaultPrevented && !event.repeat && event.key === "Enter" && event.metaKey !== event.ctrlKey
    && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

export const replyNavigationShortcuts = "Control+ArrowUp Control+ArrowDown Meta+ArrowUp Meta+ArrowDown";

export function navigateReply(
  event: KeyboardEvent<HTMLTextAreaElement | HTMLOListElement>,
  list: HTMLOListElement | null,
  replyId: string | undefined,
  cancelReply: () => void,
) {
  const { target, currentTarget, key } = event;
  if (!list || list.hidden || event.defaultPrevented || event.repeat
    || (key !== "ArrowUp" && key !== "ArrowDown") || event.ctrlKey === event.metaKey || event.altKey || event.shiftKey
    || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  if (currentTarget instanceof HTMLTextAreaElement) {
    if (target !== currentTarget || currentTarget.disabled || currentTarget.readOnly
      || (event.metaKey && currentTarget.value !== "")) return false;
  } else if (target !== list && (!(target instanceof HTMLElement)
    || !list.contains(target) || !target.matches(".mtg-message[data-message-id]"))) return false;

  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-swipe-reply]:enabled"));
  const current = replyId === undefined ? -1
    : buttons.findIndex((button) => button.closest<HTMLElement>("[data-message-id]")?.dataset.messageId === replyId);
  if (replyId !== undefined && current < 0) return false;
  const next = key === "ArrowUp" ? buttons[current < 0 ? buttons.length - 1 : current - 1]
    : current < 0 ? undefined : buttons[current + 1];
  if (!next && (key === "ArrowUp" || current < 0)) return false;

  event.preventDefault();
  if (next) {
    next.click();
    next.closest(".mtg-message")?.scrollIntoView?.({ block: "nearest" });
  } else cancelReply();
  return true;
}

export function composerKeys(event: KeyboardEvent<HTMLTextAreaElement>, editLast?: () => boolean) {
  if (editLast && event.currentTarget.value === "" && isPlainKey(event, "ArrowUp") && editLast()) {
    event.preventDefault();
    return;
  }
  submitComposerOnEnter(event);
}

function canUsePanelShortcut(event: KeyboardEvent, scope?: HTMLElement) {
  return !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
    && event.target instanceof HTMLElement
    && !event.target.closest("input, textarea, select, [contenteditable]") && inShortcutScope(event.target, scope);
}

function inShortcutScope(target: Element, scope?: HTMLElement) {
  if (scope && !scope.contains(target)) return false;
  const dialog = target.closest("dialog, [role=dialog]");
  return !dialog || !!scope && dialog.contains(scope);
}

export function isPanelShortcut(event: KeyboardEvent, scope?: HTMLElement) {
  return canUsePanelShortcut(event, scope) && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export function isControlPanelShortcut(event: KeyboardEvent, key: string, code?: string) {
  const matchingKey = event.key.toLowerCase() === key || (code && event.code === code && /^\p{Script=Cyrillic}$/u.test(event.key));
  return !!matchingKey && canUsePanelShortcut(event) && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function isFindShortcut(event: KeyboardEvent, scope?: HTMLElement) {
  const findKey = event.key.toLowerCase() === "f" || (event.code === "KeyF" && /^\p{Script=Cyrillic}$/u.test(event.key));
  return !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
    && findKey && !event.shiftKey && !event.altKey && event.ctrlKey !== event.metaKey
    && event.target instanceof Element && inShortcutScope(event.target, scope);
}

function hasSaveKey(event: KeyboardEvent) {
  return (event.key.toLowerCase() === "s" || (event.code === "KeyS" && /^\p{Script=Cyrillic}$/u.test(event.key)))
    && !event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
    && !event.shiftKey && !event.altKey;
}

export function isSaveShortcut(event: KeyboardEvent) {
  return hasSaveKey(event)
    && event.ctrlKey !== event.metaKey
    && event.target instanceof Element && !event.target.closest("input, textarea, select, [contenteditable]");
}

export function isStashShortcut(event: KeyboardEvent) {
  const target = event.target;
  return hasSaveKey(event) && event.ctrlKey && !event.metaKey
    && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && !target.readOnly && !target.closest("dialog, [role=dialog]");
}

export function submitComposerOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey
    || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat) return;
  const form = event.currentTarget.form;
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]:enabled');
  if (submit) form?.requestSubmit(submit);
}
