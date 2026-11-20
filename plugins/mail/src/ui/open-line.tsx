// Read statuses: one quiet line under a sent message that carries the image.
import { tx, txn } from "./i18n/index.ts";
import { formatFullDate } from "./thread-list.tsx";

/** "Opened 3 times \u00b7 last 20 Nov, 14:05". */
export function openedText(opens: { count: number; lastAt: string | null }): string {
  const count = txn(opens.count, "Opened {count} time", "Opened {count} times");
  return opens.lastAt === null ? count : `${count} \u00b7 ${tx("last {when}", { when: formatFullDate(opens.lastAt) })}`;
}

/** The list's mark on a conversation whose sent message was opened. */
export function OpenedMark({ opens }: { opens: { count: number; lastAt: string | null } | undefined }) {
  if (opens === undefined || opens.count === 0) return null;
  return (
    <span aria-label={tx("Opened")} title={openedText(opens)} className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
      {tx("Opened")}
    </span>
  );
}

export function OpenLine({ opens }: { opens: { count: number; lastAt: string | null } | undefined }) {
  if (opens === undefined) return null;
  const text =
    opens.count === 0 || opens.lastAt === null
      ? tx("Not opened yet")
      : openedText(opens);
  return (
    <p aria-label={tx("Read status")} title={tx("An open is a hint, not a proof: some mail services fetch images by themselves, and many programs never do.")} className="text-xs text-muted-foreground">
      {text}
    </p>
  );
}
