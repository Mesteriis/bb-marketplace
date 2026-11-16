// "Move to…": the folders of the messages' account that can hold mail, minus
// the folder they are in. A selection across accounts cannot move: the
// server moves within one account only.
import type { Folder } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stopEscape } from "./shortcuts.ts";
import { Icon } from "@/components/ui/icon";
import { folderIcon, folderRows } from "./folder-list.tsx";

/** The folders a move can go to: the account's selectable folders, not the sources. */
export function moveDestinations(
  folders: readonly Folder[],
  accountId: string,
  sources: readonly string[],
): Folder[] {
  return folders.filter((f) => f.accountId === accountId && f.selectable && !sources.includes(f.path));
}

/**
 * The folder picker of Move to… (also the snooze folder's "Use an existing
 * folder…"): `destinations` as buttons, with non-selectable parents as group
 * labels so the tree stays readable.
 */
export function FolderPickList({
  folders,
  accountId,
  destinations,
  onPick,
}: {
  folders: readonly Folder[];
  accountId: string;
  destinations: readonly Folder[];
  onPick: (path: string) => void;
}) {
  if (destinations.length === 0) {
    return <p className="text-sm text-muted-foreground">There is no other folder to move to.</p>;
  }
  const rows = folderRows(
    folders.filter((f) => f.accountId === accountId && (destinations.includes(f) || !f.selectable)),
  );
  return (
    <ul aria-label="Folders" className="flex max-h-80 flex-col gap-px overflow-y-auto">
      {rows.map((row) =>
        row.kind === "group" ? (
          <li
            key={row.folder.path}
            style={{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }}
            className="truncate pb-0.5 pt-2 text-xs font-medium text-muted-foreground"
          >
            {row.folder.name}
          </li>
        ) : (
          <li key={row.folder.path}>
            <button
              type="button"
              onClick={() => onPick(row.folder.path)}
              style={{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }}
              className="flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon name={folderIcon(row.folder.specialUse)} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.folder.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export interface MoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account's folders (other accounts' are ignored). */
  folders: readonly Folder[];
  /** The account of the messages; null when they span several. */
  accountId: string | null;
  /** Paths the messages are in; never offered. */
  sources: readonly string[];
  onMove: (destinationPath: string) => void;
  /** Where focus goes when the dialog closes (it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
  /** The compact (drawer) layout's close hook. */
  onAfterCloseAutoFocus?: () => void;
}

export function MoveDialog({
  open,
  onOpenChange,
  folders,
  accountId,
  sources,
  onMove,
  onCloseAutoFocus,
  onAfterCloseAutoFocus,
}: MoveDialogProps) {
  const destinations = accountId === null ? [] : moveDestinations(folders, accountId, sources);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape} onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Move to…</DialogTitle>
          <DialogDescription>
            {accountId === null
              ? "Moving works within one account. Select conversations of one account to move them."
              : "Choose a folder of the same account."}
          </DialogDescription>
        </DialogHeader>
        {accountId !== null ? <FolderPickList folders={folders} accountId={accountId} destinations={destinations} onPick={onMove} /> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
