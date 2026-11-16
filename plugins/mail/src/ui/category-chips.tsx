// Local categories (slice 3f): Bills, Notifications, Personal, Newsletters.
// Labels live only in Makosh Mail (no IMAP keyword or label). A suggestion
// (the local rules', else a model's) is shown as such until the owner
// accepts it; nothing is labelled without the owner's click.
import { useState } from "react";
import type { ThreadSummary } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type Category = NonNullable<ThreadSummary["category"]>;

export const CATEGORIES: readonly { value: Category; label: string }[] = [
  { value: "bills", label: "Bills" },
  { value: "notifications", label: "Notifications" },
  { value: "personal", label: "Personal" },
  { value: "newsletters", label: "Newsletters" },
];

export function categoryLabel(category: Category): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? category;
}

const NONE = "none";

/** A row's chip: the label, or the suggestion marked as one. */
export function RowCategory({ category, suggestion }: { category: Category | null; suggestion: Category | null }) {
  if (category !== null) {
    return (
      <span className="shrink-0 rounded-sm bg-muted px-1 text-xs text-muted-foreground">{categoryLabel(category)}</span>
    );
  }
  if (suggestion !== null) {
    return (
      <span
        title="Suggested category"
        className="shrink-0 rounded-sm border border-dashed border-border px-1 text-xs text-muted-foreground"
      >
        {`${categoryLabel(suggestion)}?`}
      </span>
    );
  }
  return null;
}

export interface CategoryChipProps {
  category: Category | null;
  suggestion: Category | null;
  onAccept: () => void;
  /** Change... to a category, or null to remove the label. */
  onChange: (category: Category | null) => void;
  /** Always for this sender: the From address; null when the message has none. */
  onAlways: ((category: Category) => void) | null;
  pending?: boolean;
}

/** The reading pane's category line. */
export function CategoryChip({ category, suggestion, onAccept, onChange, onAlways, pending = false }: CategoryChipProps) {
  const [changing, setChanging] = useState(false);
  const shown = category ?? suggestion;
  return (
    <div role="group" aria-label="Category" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {category !== null ? (
        <span>
          {"Category: "}
          <span className="text-foreground">{categoryLabel(category)}</span>
        </span>
      ) : suggestion !== null ? (
        <>
          <span>
            {"Suggested category: "}
            <span className="text-foreground">{categoryLabel(suggestion)}</span>
          </span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={onAccept}>
            Accept
          </Button>
        </>
      ) : (
        <span>No category</span>
      )}
      {changing ? (
        <Select
          value={category ?? NONE}
          onValueChange={(value) => {
            setChanging(false);
            onChange(value === NONE ? null : (value as Category));
          }}
          defaultOpen
          onOpenChange={(open) => {
            if (!open) setChanging(false);
          }}
        >
          <SelectTrigger aria-label="Change category" className="h-6 w-auto px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
            <SelectItem value={NONE}>No category</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={() => setChanging(true)}>
          {"Change\u2026"}
        </Button>
      )}
      {onAlways !== null && shown !== null ? (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={() => onAlways(shown)}>
          {`Always ${categoryLabel(shown)} for this sender`}
        </Button>
      ) : null}
    </div>
  );
}

/** The list's category filters, beside the quick filters: one at a time. */
export function CategoryFilters({
  value,
  onChange,
}: {
  value: Category | undefined;
  onChange: (next: Category | undefined) => void;
}) {
  return (
    <>
      {CATEGORIES.map((c) => {
        const on = value === c.value;
        return (
          <Button
            key={c.value}
            variant={on ? "secondary" : "ghost"}
            size="sm"
            className={cn("h-6 px-2 text-xs", !on && "text-muted-foreground")}
            aria-pressed={on}
            onClick={() => onChange(on ? undefined : c.value)}
          >
            {c.label}
          </Button>
        );
      })}
    </>
  );
}
