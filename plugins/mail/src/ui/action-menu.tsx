// A small menu of actions for a rail item (slice 3h): a folder, an account
// or a saved search. The design system has no dropdown, so the menu is a
// dialog with a list of buttons and checkboxes; it opens from a "More" button
// beside the item and closes on a pick.
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { stopEscape } from "./shortcuts.ts";

export type MenuEntry =
  | { kind: "action"; id: string; label: string; icon?: string; disabled?: boolean; destructive?: boolean }
  | { kind: "check"; id: string; label: string; checked: boolean; disabled?: boolean };

export function ActionMenu({
  title,
  description,
  entries,
  open,
  onPick,
  onClose,
}: {
  title: string;
  description?: string;
  entries: readonly MenuEntry[];
  open: boolean;
  /** A pick; the menu closes first. */
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const pick = (id: string) => {
    onClose();
    onPick(id);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xs" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <ul aria-label={`${title} actions`} className="flex flex-col gap-px">
          {entries.map((entry) => (
            <li key={entry.id}>
              {entry.kind === "action" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={entry.disabled}
                  className={entry.destructive === true ? "w-full justify-start text-destructive" : "w-full justify-start"}
                  onClick={() => pick(entry.id)}
                >
                  {entry.icon !== undefined ? <Icon name={entry.icon} fallback="Folder" aria-hidden /> : null}
                  {entry.label}
                </Button>
              ) : (
                <label className="flex h-8 items-center gap-2 rounded-md px-3 text-sm hover:bg-state-hover">
                  <Checkbox
                    checked={entry.checked}
                    disabled={entry.disabled}
                    onCheckedChange={() => pick(entry.id)}
                  />
                  <span>{entry.label}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
