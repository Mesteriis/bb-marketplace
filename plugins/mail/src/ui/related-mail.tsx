// Related mail (slice 3h, #83): under a conversation, "Related (n)" opens
// a short list of messages Mail ranked locally, each with why it is there.
// Nothing reaches an AI provider; the list loads on the first open.
import { useEffect, useState } from "react";
import type { RelatedHit, RelatedReason } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { addressLabel, formatListDate, subjectOrPlaceholder } from "./thread-list.tsx";

/** Why a message is related, as the owner reads it. */
export function relatedReasonText(reason: RelatedReason): string {
  switch (reason.kind) {
    case "participants":
      return "same people";
    case "reference":
      return "replies or refers to it";
    case "terms":
      return reason.terms.length === 0 ? "similar subject" : `mentions ${reason.terms.slice(0, 3).join(", ")}`;
  }
}

export function RelatedMail({
  messageId,
  load,
  onOpen,
}: {
  /** The message the list is related to (the conversation's newest). */
  messageId: string;
  load: (messageId: string) => Promise<RelatedHit[]>;
  onOpen: (hit: RelatedHit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<RelatedHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Another conversation: the list starts closed again (reset while rendering, not after a click).
  const [forId, setForId] = useState(messageId);
  if (forId !== messageId) {
    setForId(messageId);
    setOpen(false);
    setHits(null);
    setError(null);
  }
  useEffect(() => {
    if (!open || hits !== null) return;
    let live = true;
    load(messageId).then(
      (found) => {
        if (live) setHits(found);
      },
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [open, hits, load, messageId]);

  return (
    <section aria-label="Related mail" className="flex flex-col gap-1">
      <div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {hits === null ? "Related" : `Related (${hits.length})`}
          <span aria-hidden>{open ? " \u25b4" : " \u25be"}</span>
        </Button>
      </div>
      {open ? (
        error !== null ? (
          <p role="alert" className="px-2 text-xs text-destructive">
            {error}
          </p>
        ) : hits === null ? (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {"Looking\u2026"}
          </p>
        ) : hits.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">No related mail.</p>
        ) : (
          <ul className="flex flex-col">
            {hits.map((hit) => (
              <li key={hit.summary.id}>
                <button
                  type="button"
                  onClick={() => onOpen(hit)}
                  className="flex w-full flex-col rounded-md px-2 py-1 text-left hover:bg-state-hover"
                >
                  <span className="flex min-w-0 items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{subjectOrPlaceholder(hit.summary.subject)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(hit.summary.date)}</span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {`${addressLabel(hit.summary.from)} \u00b7 ${hit.reasons.map(relatedReasonText).join(", ")}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
