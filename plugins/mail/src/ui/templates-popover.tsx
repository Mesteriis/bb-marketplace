// The composer's template picker (slice 3d): the toolbar's Templates button
// or Mod+Alt+T opens it under the toolbar. Typing filters by name; arrows
// move; Enter or a click inserts the template's blocks at the cursor;
// Escape closes it and gives the editor its focus back. Manage templates…
// opens Mail settings.
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TemplateView } from "./mail-settings.tsx";
import { docPreview } from "./mail-settings.tsx";

export interface TemplatesPopoverProps {
  templates: readonly TemplateView[];
  onInsert: (template: TemplateView) => void;
  onManage: () => void;
  onClose: () => void;
}

export function TemplatesPopover({ templates, onInsert, onManage, onClose }: TemplatesPopoverProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => q === "" || t.name.toLowerCase().includes(q));
  }, [query, templates]);
  const current = Math.min(highlight, Math.max(0, shown.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current + step + shown.length) % shown.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Cmd/Ctrl+Enter is the composer's Send; here it does nothing.
      event.stopPropagation();
      const picked = shown[current];
      if (picked !== undefined && !event.metaKey && !event.ctrlKey) onInsert(picked);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const listId = `${id}-templates`;
  return (
    <div
      role="dialog"
      aria-label="Templates"
      className="mt-1 flex max-w-sm flex-col gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <Input
        autoFocus
        role="combobox"
        aria-label="Find a template"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown.length > 0 ? `${id}-option-${current}` : undefined}
        placeholder="Find a template"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        className="h-7 text-xs"
      />
      {shown.length > 0 ? (
        <ul id={listId} role="listbox" aria-label="Templates" className="flex max-h-64 flex-col overflow-y-auto">
          {shown.map((template, index) => (
            <li
              key={template.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === current}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => onInsert(template)}
              className={cn(
                "flex cursor-pointer flex-col rounded-sm px-2 py-1 text-sm",
                index === current && "bg-state-hover",
              )}
            >
              <span className="truncate text-foreground">{template.name}</span>
              <span className="truncate text-xs text-muted-foreground">{docPreview(template.doc).split("\n")[0]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {templates.length === 0 ? "No templates yet." : "No template has this name."}
        </p>
      )}
      <Button variant="ghost" size="sm" className="h-7 justify-start" onClick={onManage}>
        Manage templates…
      </Button>
    </div>
  );
}
