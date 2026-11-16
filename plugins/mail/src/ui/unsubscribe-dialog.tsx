// "Unsubscribe from <list>?" (slice 3e): the one method the pane offers
// (one click to the list's host, or an email to its address), and always the
// privacy cost: unsubscribing confirms that this address is read. Cancel has
// the focus, so Enter never unsubscribes by accident.
import { useRef } from "react";
import type { UnsubscribeInfoView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { shownText } from "./agent-send-card.tsx";
import { stopEscape } from "./shortcuts.ts";

export type UnsubscribeMethod = "one_click" | "mailto";

export const UNSUBSCRIBE_PRIVACY =
  "Unsubscribing tells the sender this address is read. Do it only for lists you signed up for; for anything else use Spam or Block.";
export const UNSUBSCRIBE_HIDDEN_HINT = "Use Spam or Block for mail you never signed up for";
export const FOREIGN_MAILTO_NOTE = "This address is not at the sender's domain.";

/** The method Unsubscribe uses first: one click when offered, else the email; null when neither is. */
export function preferredMethod(info: UnsubscribeInfoView | null): UnsubscribeMethod | null {
  if (info === null || info.hidden) return null;
  if (info.methods.oneClick !== null) return "one_click";
  if (info.methods.mailto !== null) return "mailto";
  return null;
}

/** Why a one-click request failed, by the server's fixed reason. */
export function unsubscribeFailureText(reason: string | null): string {
  switch (reason) {
    case "client":
      return "the list refused the request";
    case "server":
      return "the list's server failed";
    case "network":
      return "the list could not be reached";
    case "tls":
      return "the secure connection failed";
    case "address":
      return "the list's address is not allowed";
    case "timeout":
      return "the list did not answer";
    default:
      return "the request failed";
  }
}

export interface UnsubscribeDialogProps {
  /** The info and the method to confirm; null: closed. */
  request: { info: UnsubscribeInfoView; method: UnsubscribeMethod } | null;
  /** The address the email would go out from (the account's). */
  fromAddress: string;
  onConfirm: (method: UnsubscribeMethod) => void;
  onCancel: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onAfterCloseAutoFocus?: () => void;
}

export function UnsubscribeDialog({
  request,
  fromAddress,
  onConfirm,
  onCancel,
  onCloseAutoFocus,
  onAfterCloseAutoFocus,
}: UnsubscribeDialogProps) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const info = request?.info ?? null;
  const method = request?.method ?? null;
  const list = info?.listName !== null && info?.listName !== undefined ? shownText(info.listName) : null;
  const mailto = info?.methods.mailto ?? null;
  const oneClick = info?.methods.oneClick ?? null;
  return (
    <Dialog
      open={request !== null}
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
        onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{list !== null ? `Unsubscribe from ${list}?` : "Unsubscribe from this list?"}</DialogTitle>
          <DialogDescription>{UNSUBSCRIBE_PRIVACY}</DialogDescription>
        </DialogHeader>
        {method === "one_click" && oneClick !== null ? (
          <p className="flex items-start gap-2 text-sm text-foreground">
            <Icon name="Link" fallback="Mail" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-all">One click to {shownText(oneClick.host)}</span>
          </p>
        ) : null}
        {method === "mailto" && mailto !== null ? (
          <div className="flex flex-col gap-1">
            <p className="flex items-start gap-2 text-sm text-foreground">
              <Icon name="Mail" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 break-all">
                An email from {fromAddress} goes to {shownText(mailto.address)}.
              </span>
            </p>
            {mailto.foreignDomain ? (
              <p role="note" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {FOREIGN_MAILTO_NOTE}
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button ref={cancel} variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={method === null} onClick={() => method !== null && onConfirm(method)}>
            Unsubscribe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
