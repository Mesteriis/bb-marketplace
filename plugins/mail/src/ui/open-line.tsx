// Read statuses: one quiet line under a sent message that carries the image.
import { tx, txn } from "./i18n/index.ts";
import { formatFullDate } from "./thread-list.tsx";

export function OpenLine({ opens }: { opens: { count: number; lastAt: string | null } | undefined }) {
  if (opens === undefined) return null;
  const text =
    opens.count === 0 || opens.lastAt === null
      ? tx("Not opened yet")
      : `${txn(opens.count, "Opened {count} time", "Opened {count} times")} \u00b7 ${tx("last {when}", { when: formatFullDate(opens.lastAt) })}`;
  return (
    <p aria-label={tx("Read status")} title={tx("An open is a hint, not a proof: some mail services fetch images by themselves, and many programs never do.")} className="text-xs text-muted-foreground">
      {text}
    </p>
  );
}
