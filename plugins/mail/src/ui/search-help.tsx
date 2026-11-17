// The search box's help and notes (slice 3h, #43): the operators Mail
// understands, and why a word of the query stayed plain text. Notes are the
// server's (`search` answers them); they render as text only.
import { useState } from "react";
import type { SearchNote } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export const SEARCH_OPERATORS: readonly { example: string; meaning: string }[] = [
  { example: "from:anna", meaning: "Sender name or address" },
  { example: "to:team@example.org", meaning: "A recipient (cc: for copies)" },
  { example: "subject:\"weekly report\"", meaning: "Words in the subject; quotes keep words together" },
  { example: "has:attachment", meaning: "Messages with attachments" },
  { example: "filename:invoice.pdf", meaning: "An attachment's name" },
  { example: "in:inbox", meaning: "inbox, sent, drafts, spam, trash, archive, snoozed" },
  { example: "is:unread", meaning: "unread, read, flagged, unflagged" },
  { example: "larger:2M", meaning: "Size; smaller: too. Sizes look like 10K or 2M" },
  { example: "after:2026-01-31", meaning: "Dates; before: too" },
  { example: "newer_than:3m", meaning: "Relative dates: d, w, m, y; older_than: too" },
  { example: "label:Travel", meaning: "A Gmail label" },
  { example: "list:news.example.org", meaning: "A mailing list" },
  { example: "category:bills", meaning: "A Mail category" },
  { example: "account:work", meaning: "One account" },
  { example: "-in:trash", meaning: "A leading - leaves matches out" },
];

/** The operator a note's word names, lower case; null for a bare word. */
function operatorOf(term: string): string | null {
  const match = /^-?([a-z][a-z_]*):/i.exec(term);
  return match === null ? null : match[1]!.toLowerCase();
}

/** What the box says about one word that stayed text. */
export function searchNoteText(note: SearchNote): string {
  if (note.kind === "unknown_operator") return `${note.term} \u2014 not an operator; searched as text`;
  switch (operatorOf(note.term)) {
    case "larger":
    case "smaller":
      return `${note.term} \u2014 not understood (sizes look like 10K or 2M)`;
    case "after":
    case "before":
      return `${note.term} \u2014 not understood (dates look like 2026-11-16)`;
    case "newer_than":
    case "older_than":
      return `${note.term} \u2014 not understood (use a number and d, w, m or y, like 3m)`;
    case "is":
      return `${note.term} \u2014 not understood (unread, read, flagged or unflagged)`;
    case "has":
      return `${note.term} \u2014 not understood (has:attachment)`;
    case "in":
      return `${note.term} \u2014 not understood (inbox, sent, drafts, spam, trash, archive or snoozed)`;
    default:
      return `${note.term} \u2014 not understood`;
  }
}

export function SearchNotes({ notes }: { notes: readonly SearchNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul aria-label={tx("Search notes")} className="flex flex-col gap-0.5 border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {notes.map((note, index) => (
        <li key={`${index}:${note.term}`}>{searchNoteText(note)}</li>
      ))}
    </ul>
  );
}

export function SearchHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="icon" aria-label={tx("Search help")} onClick={() => setOpen(true)}>
        <Icon name="HelpCircle" fallback="Info" aria-hidden />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
          <DialogHeader>
            <DialogTitle>{tx("Search operators")}</DialogTitle>
            <DialogDescription>{tx("Combine them with words. Everything else is searched as text.")}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {SEARCH_OPERATORS.map((row) => (
              <div key={row.example} className="contents">
                <dt className="font-mono text-xs text-foreground">{row.example}</dt>
                <dd className="text-muted-foreground">{row.meaning}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
