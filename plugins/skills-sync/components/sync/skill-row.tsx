import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { changeSummary, isEntirelyCosmetic, type SkillStatus } from "./model";

/**
 * One skill. The name and a plain-words summary of what moved; clicking
 * anywhere on the summary opens the diffs underneath. A checkbox appears only
 * where ticking it is a safe action — never on a conflict, where applying would
 * quietly throw away the user's own edit.
 */
export function SkillRow({
  skill,
  selectable,
  checked,
  onCheckedChange,
  expanded,
  onToggleExpanded,
  children,
}: {
  skill: SkillStatus;
  selectable: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  children: ReactNode;
}) {
  const cosmetic = isEntirelyCosmetic(skill);
  return (
    <li className="px-3">
      <div className="flex items-center gap-3 py-2">
        {selectable ? (
          <Checkbox
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next === true)}
            aria-label={`Apply ${skill.name}`}
          />
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-sm",
              cosmetic && "text-muted-foreground",
            )}
          >
            {skill.name}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs",
              cosmetic ? "text-muted-foreground/70" : "text-muted-foreground",
            )}
          >
            {changeSummary(skill)}
          </span>
        </button>
      </div>
      {expanded ? <div className="pb-3 pl-7">{children}</div> : null}
    </li>
  );
}
