// "Ready to start" (slice 3g, #82): rule runs a mail rule prepared, beside
// the Waiting-for-a-reply strip. Review opens New thread with the rule's
// project and template; Dismiss drops the run; Pause all rules turns every
// rule off (the page toasts Undo). Capped and failed runs show why.
import type { RuleRunView } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { subjectOrPlaceholder } from "./thread-list.tsx";

export interface RuleStripProps {
  runs: readonly RuleRunView[];
  onReview: (run: RuleRunView) => void;
  onDismiss: (run: RuleRunView) => void;
  onPauseAll: () => void;
}

const STATE_TEXT: Partial<Record<RuleRunView["state"], string>> = {
  capped: "over the rule's limit: start it yourself",
  failed: "BB could not start it",
};

export function RuleStrip({ runs, onReview, onDismiss, onPauseAll }: RuleStripProps) {
  if (runs.length === 0) return null;
  return (
    <section aria-label="Ready to start" className="flex flex-col gap-1 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="Bot" className="size-3.5 text-muted-foreground" aria-hidden />
        <h3 className="min-w-0 flex-1 text-xs font-semibold text-foreground">{`Ready to start (${runs.length})`}</h3>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onPauseAll}>
          Pause all rules
        </Button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {runs.map((run) => (
          <li key={run.id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">{run.ruleName ?? "A deleted rule"}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{subjectOrPlaceholder(run.subject)}</span>
            {STATE_TEXT[run.state] !== undefined ? <span className="text-muted-foreground">{STATE_TEXT[run.state]}</span> : null}
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={run.ruleName === null} onClick={() => onReview(run)}>
              Review
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onDismiss(run)}>
              Dismiss
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
