// What the page needs from the outside. The BB adapter in app.tsx supplies
// these; the page never calls the host itself.
import type { Attachment } from "../core/attachment.ts";
import type { Staging } from "../core/staging.ts";
import type { ProposeOutcome, WindowStatusView } from "../core/window-status.ts";
import type { ProposalSource } from "../core/window-session.ts";

export type Notify = (kind: "info" | "success" | "error", message: string) => void;

export interface WindowApi {
  open(): Promise<WindowStatusView>;
  propose(text: string, source: ProposalSource): Promise<ProposeOutcome>;
  /** Place the window on the page's reserved area, or hide it. */
  attach(view: Attachment): void;
}

export interface DockServices {
  staging: Staging;
  window: WindowApi;
  /** Write the system clipboard. Called only from a user's own action. */
  copyText(text: string): Promise<boolean>;
  notify: Notify;
}

/**
 * True for an event the user produced. Scripted `click()` calls and
 * dispatched events are not trusted, so a handler guarded by this cannot be
 * triggered from code running in the page.
 */
export type IsUserAction = (event: { nativeEvent: Event }) => boolean;

export const isTrustedEvent: IsUserAction = (event) => event.nativeEvent.isTrusted === true;

export const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
export const BUTTON_PRIMARY = BUTTON + " bg-foreground text-background hover:bg-foreground/90";
export const BUTTON_OUTLINE = BUTTON + " border border-input bg-transparent hover:bg-state-hover hover:text-foreground";
export const BUTTON_GHOST = BUTTON + " hover:bg-state-hover hover:text-foreground";
