// AI sorts the inbox: the owner's AI labels a message got, as small chips.
import { tx } from "./i18n/index.ts";

/** Chips shown before "+n". */
export const AI_CHIPS_SHOWN = 2;

export function AiLabelChips({ labels, all = false }: { labels: readonly string[]; /** Every label, not the first two. */ all?: boolean }) {
  if (labels.length === 0) return null;
  const shown = all ? labels : labels.slice(0, AI_CHIPS_SHOWN);
  const more = labels.length - shown.length;
  return (
    <span aria-label={tx("AI labels")} title={labels.join(", ")} className="flex shrink-0 items-center gap-1">
      {shown.map((label) => (
        <span key={label} className="max-w-28 truncate rounded-sm bg-primary/10 px-1 text-xs text-foreground">
          {label}
        </span>
      ))}
      {more > 0 ? <span className="text-xs text-muted-foreground">{`+${more}`}</span> : null}
    </span>
  );
}

/** The one line a model wrote about a message, with its labels: above an open message. */
export function AiLine({ summary, labels }: { summary: string | null | undefined; labels: readonly string[] | undefined }) {
  const line = (summary ?? "").trim();
  const list = labels ?? [];
  if (line === "" && list.length === 0) return null;
  return (
    <p aria-label={tx("AI summary")} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {line !== "" ? <span className="min-w-0 break-words">{line}</span> : null}
      <AiLabelChips labels={list} all />
    </p>
  );
}
