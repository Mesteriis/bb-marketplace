// Links in a message (slice 3i, #40): the status line that shows where a
// hovered or focused link really goes, and the dialog that asks before a
// deceptive one opens. Every value is the sender's and shown as plain text;
// hosts are ASCII (punycode), never decoded.
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cleanLink, type CleanLink } from "../core/link-clean.ts";
import { orgDomain } from "../core/sender-basics.ts";
import { shownText } from "./agent-send-card.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

/** A link under the pointer or focus in a message frame. */
export interface LinkHover {
  /** The href as the frame has it (already cleaned when cleanLinks is on). */
  href: string;
  /** The anchor's visible text, trimmed; null for none. */
  text: string | null;
  /** Parameters the sanitizer removed (`data-mk-cleaned`). */
  removed: number;
  /** The sanitizer unwrapped a redirect wrapper (`data-mk-unwrapped`). */
  unwrapped: boolean;
}

/** The URL as shown: its host in ASCII. */
export function displayUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** The status line's text for a link, or null when the link opens nothing. */
export function linkStatusText(hover: LinkHover, cleanLinks: boolean): string | null {
  const clean = cleanLink(hover.href, hover.text, { clean: cleanLinks });
  if (clean === null) return null;
  if (clean.trackingHost !== null) {
    return `\u2192 via tracking redirect at ${clean.trackingHost}; Mail cannot see where it ends`;
  }
  const removed = hover.removed + clean.removedParams;
  const notes: string[] = [];
  if (removed > 0) notes.push(removed === 1 ? "1 tracking parameter removed" : `${removed} tracking parameters removed`);
  if (hover.unwrapped || clean.unwrapped) notes.push("redirect removed");
  return `\u2192 ${displayUrl(clean.url)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * The sticky line at the bottom of the reading pane's scroll area (part A
 * resolution 14): one per pane, the hovered message's.
 */
export function LinkStatusLine({ hover, cleanLinks }: { hover: LinkHover | null; cleanLinks: boolean }) {
  const text = hover === null ? null : linkStatusText(hover, cleanLinks);
  if (text === null) return null;
  return (
    <div
      role="status"
      aria-label={tx("Link address")}
      data-mail-link-status=""
      className="sticky bottom-0 z-10 -mx-4 truncate border-t border-border bg-card px-4 py-1 font-mono text-xs text-muted-foreground"
    >
      {shownText(text)}
    </div>
  );
}

/** What the dialog says about a link that needs it (part A resolution 10). */
export function linkDialogText(clean: CleanLink): { reason: string; host: string } {
  const host = clean.deceptive !== null ? orgDomain(clean.host) : clean.host;
  if (clean.deceptive !== null) return { reason: `This link says ${clean.deceptive.says} but opens ${host}.`, host };
  if (clean.lookalike !== null) return { reason: `${clean.host} looks like ${clean.lookalike}, which you write to.`, host };
  return { reason: `This link's address mixes alphabets: ${clean.host} (shown as it really is).`, host };
}

export interface LinkDialogProps {
  /** The link that needs a decision; null: closed. */
  link: CleanLink | null;
  onOpen: (link: CleanLink) => void;
  onCancel: () => void;
}

/** "Open evil.org?" with Open and Cancel; Cancel has the focus. */
export function LinkDialog({ link, onOpen, onCancel }: LinkDialogProps) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const text = link === null ? null : linkDialogText(link);
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onEscapeKeyDown={stopEscape}
      >
        <DialogHeader>
          <DialogTitle>{text === null ? tx("Open this link?") : `Open ${shownText(text.host)}?`}</DialogTitle>
          <DialogDescription className="break-all">{text === null ? "" : shownText(text.reason)}</DialogDescription>
        </DialogHeader>
        {link !== null ? <p className="break-all font-mono text-xs text-muted-foreground">{shownText(displayUrl(link.url))}</p> : null}
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            {tx("Cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (link !== null) onOpen(link);
            }}
          >
            {tx("Open")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
