// What the page needs from the outside. The BB adapter in app.tsx supplies
// these; the page never calls the host itself.
import type { Attachment } from "../core/attachment.ts";
import type { WindowStatusView } from "../core/window-status.ts";

export interface WindowApi {
  open(): Promise<WindowStatusView>;
  /** Place the window on the page, or hide it. */
  attach(view: Attachment): void;
}

export const BUTTON_OUTLINE =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
