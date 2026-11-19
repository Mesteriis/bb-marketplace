// Quick quote (typing speed): the text the owner selected inside one
// message, for a reply that quotes only that. An HTML body lives in a
// same-origin sandboxed frame, so its selection is read from the frame.
import { QUOTE_MAX } from "../core/compose-reply.ts";

/**
 * The selection inside the message `messageId` shown under `root`, as plain
 * text; null when nothing is selected there, when the selection reaches
 * outside the message, or when it is only white space.
 */
export function selectedQuote(root: Document, messageId: string): string | null {
  const holder = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]")).find((el) => el.dataset.messageId === messageId);
  if (holder === undefined) return null;
  let text = "";
  for (const frame of Array.from(holder.querySelectorAll("iframe"))) {
    try {
      text = frame.contentDocument?.getSelection()?.toString() ?? "";
    } catch {
      text = "";
    }
    if (text.trim() !== "") break;
  }
  if (text.trim() === "") {
    const selection = root.getSelection();
    const inside = (node: Node | null) => node !== null && holder.contains(node);
    if (selection === null || selection.isCollapsed || !inside(selection.anchorNode) || !inside(selection.focusNode)) return null;
    text = selection.toString();
  }
  const clean = text.replace(/\r\n?/g, "\n").trim();
  return clean === "" ? null : clean.slice(0, QUOTE_MAX);
}
