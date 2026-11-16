import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "./disclosure";
import type { CatalogueEntry } from "./model";

/**
 * Everything upstream offers that is not installed here. This is browsing, not
 * a work list: it starts folded, nothing in it is ticked for you, and an entry
 * the user already declined looks exactly like one they have never seen —
 * because revisiting that decision is the whole point of the section.
 *
 * Ticking a row adds it to the same selection the sections above use, so the
 * Apply button at the bottom installs it along with everything else.
 */
export function CatalogueSection({
  catalogue,
  selected,
  onCheckedChange,
}: {
  catalogue: readonly CatalogueEntry[];
  selected: ReadonlySet<string>;
  onCheckedChange: (names: string[], checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  if (catalogue.length === 0) return null;
  return (
    <section aria-label="Available, not installed" className="mt-5">
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        summary={`${catalogue.length} more ${catalogue.length === 1 ? "skill" : "skills"} upstream you have not installed`}
      >
        <p className="mb-2 text-xs text-muted-foreground">
          Tick any of these to install them with the rest.
        </p>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {catalogue.map((entry) => (
            <li key={`${entry.upstreamBucket}/${entry.name}`} className="px-3">
              <label className="flex items-start gap-3 py-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(entry.name)}
                  onCheckedChange={(next) =>
                    onCheckedChange([entry.name], next === true)
                  }
                  aria-label={`Install ${entry.name}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-sm">{entry.name}</span>
                    {entry.upstreamBucket === "" ? null : (
                      <span className="text-xs text-muted-foreground">
                        {entry.upstreamBucket}
                      </span>
                    )}
                    {entry.offered ? (
                      <span className="text-xs text-muted-foreground">
                        also listed under New
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {entry.description === ""
                      ? "No description upstream."
                      : entry.description}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
