import type { KeyboardEvent } from "react";

export function submitComposerOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey
    || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat) return;
  const form = event.currentTarget.form;
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]:enabled');
  if (submit) form?.requestSubmit(submit);
}
