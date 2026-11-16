import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * A quiet fold-out row: a full-width summary button plus its body. Used for the
 * commit list, the foreign-skills line, and the sections that start folded.
 */
export function Disclosure({
  open,
  onOpenChange,
  summary,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center gap-1.5 rounded text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="size-3.5 shrink-0"
          aria-hidden
        />
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      <div className={cn(open ? "mt-2" : "hidden")}>{open ? children : null}</div>
    </div>
  );
}
