// "Before you send" (slice 3d): the advisory issues compose_check found.
// Nothing here blocks a send: Send anyway queues it. Back to editing has
// the focus, Enter and Escape; Send anyway takes a click, or Tab then
// Enter. Cmd/Ctrl+Enter does nothing here, so the composer's send chord
// cannot skip the list by accident. Fix closes the dialog and takes the
// owner to the issue.
import { useRef, type KeyboardEvent } from "react";
import type { PresendIssue } from "../core/presend.ts";
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
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export type { PresendIssue };

/** One issue's line and its Fix label. */
export function presendIssueText(issue: PresendIssue): { text: string; fix: string } {
  switch (issue.kind) {
    case "attachment_mentioned":
      return { text: tx("You wrote \u201c{phrase}\u201d, but nothing is attached.", { phrase: issue.phrase }), fix: "Attach a file" };
    case "empty_subject":
      return { text: tx("The subject is empty."), fix: "Add a subject" };
    case "outside_conversation":
      return { text: tx("Not in this conversation: {p1}", { p1: issue.addresses.join(", ") }), fix: "Check recipients" };
    case "new_recipients":
      return { text: tx("You have not written to {p1} before.", { p1: issue.addresses.join(", ") }), fix: "Check recipients" };
    case "bb_files":
      return {
        text: `${issue.count} ${issue.count === 1 ? "file" : "files"} from BB: ${issue.origins.join(", ")}`,
        fix: "Check attachments",
      };
    case "looks_secret":
      return { text: tx("The text looks like it holds a password, token or code ({count})", { count: issue.count }), fix: "Check the text" };
    case "placeholder_left":
      return { text: tx("{first_name} from a template is still in the message."), fix: "Check the text" };
    case "reply_to_elsewhere":
      return { text: tx("Reply-To differs from the sender: {p1}", { p1: issue.addresses.join(", ") }), fix: "Check recipients" };
  }
}

export interface PresendDialogProps {
  /** The issues; the dialog is open while there are any. */
  issues: readonly PresendIssue[] | null;
  /** Fix on an issue; what it returns is focused once the dialog has closed. */
  onFix: (issue: PresendIssue) => (() => void) | void;
  onBack: () => void;
  onSendAnyway: () => void;
}

export function PresendDialog({ issues, onFix, onBack, onSendAnyway }: PresendDialogProps) {
  const back = useRef<HTMLButtonElement | null>(null);
  const focusAfter = useRef<(() => void) | null>(null);
  const open = issues !== null && issues.length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onBack();
      }}
    >
      <DialogContent
        className="max-w-md"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          back.current?.focus();
        }}
        onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={(event) => {
          const focus = focusAfter.current;
          focusAfter.current = null;
          if (focus === null) return;
          event.preventDefault();
          focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{tx("Before you send")}</DialogTitle>
          <DialogDescription>{tx("These may be on purpose; nothing stops the send.")}</DialogDescription>
        </DialogHeader>
        <ul aria-label={tx("Issues")} className="flex flex-col gap-2">
          {(issues ?? []).map((issue, index) => {
            const { text, fix } = presendIssueText(issue);
            return (
              <li key={`${issue.kind}-${index}`} className="flex items-start gap-2 text-sm">
                <Icon
                  name="TriangleAlert"
                  fallback="Info"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 break-words text-foreground">{text}</span>
                <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => {
                    focusAfter.current = onFix(issue) ?? null;
                  }}>
                  {fix}
                </Button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button ref={back} size="sm" onClick={onBack}>
            {tx("Back to editing")}
          </Button>
          <Button variant="outline" size="sm" onClick={onSendAnyway}>
            {tx("Send anyway")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
