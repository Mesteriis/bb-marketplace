// The snooze folder (slice 3e). The first snooze in an account asks before
// anything is created on the server: Create folder (the final name by
// preset), Use an existing folder… (the move dialog's picker, without system
// folders) or Cancel. Mail settings opens it to change the folder; then only
// the picker is offered.
import { useEffect, useState } from "react";
import type { Folder, SpecialUse } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderPickList } from "./move-dialog.tsx";
import { stopEscape } from "./shortcuts.ts";

/** Folders that never hold snoozed mail (the server refuses them too). */
const REFUSED_USES: ReadonlySet<SpecialUse> = new Set(["inbox", "sent", "drafts", "junk", "trash", "all"]);

/** The folders an account's snoozed mail may wait in. */
export function snoozeFolderChoices(folders: readonly Folder[], accountId: string, current: string | null): Folder[] {
  return folders.filter(
    (f) =>
      f.accountId === accountId &&
      f.selectable &&
      f.path.toUpperCase() !== "INBOX" &&
      f.path !== current &&
      (f.specialUse === null || !REFUSED_USES.has(f.specialUse)),
  );
}

export interface SnoozeFolderRequest {
  accountId: string;
  /** The account's address, as the dialog names it. */
  accountLabel: string;
  /** The name Create folder would create. */
  proposedName: string;
  /** The folder in use now (Mail settings' Change…); null when there is none yet. */
  current: string | null;
}

export interface SnoozeFolderDialogProps {
  request: SnoozeFolderRequest | null;
  /** The account's folders, for Use an existing folder…; null while they load. */
  folders: readonly Folder[] | null;
  onCreate: (accountId: string) => Promise<void>;
  onUse: (accountId: string, path: string) => Promise<void>;
  onCancel: () => void;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SnoozeFolderDialog({ request, folders, onCreate, onUse, onCancel }: SnoozeFolderDialogProps) {
  const changing = request !== null && request.current !== null;
  const [picking, setPicking] = useState(changing);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = request === null ? null : `${request.accountId}\u0000${request.current ?? ""}`;
  useEffect(() => {
    setPicking(changing);
    setBusy(false);
    setProblem(null);
  }, [key]);

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  const choices = request === null || folders === null ? [] : snoozeFolderChoices(folders, request.accountId, request.current);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>
            {changing
              ? "Snoozed folder"
              : picking
                ? "Use an existing folder"
                : `Create a folder '${request?.proposedName ?? ""}' in ${request?.accountLabel ?? ""}?`}
          </DialogTitle>
          <DialogDescription>
            {changing
              ? `Snoozed mail of ${request?.accountLabel ?? ""} waits in '${request?.current ?? ""}'. Mail snoozed there now stays there until it returns.`
              : "Snoozed mail waits there and comes back to the Inbox at the time you pick."}
          </DialogDescription>
        </DialogHeader>
        {picking && request !== null ? (
          folders === null ? (
            <p className="text-sm text-muted-foreground">Loading folders…</p>
          ) : choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">There is no other folder that can hold snoozed mail.</p>
          ) : (
            <FolderPickList
              folders={folders}
              accountId={request.accountId}
              destinations={choices}
              onPick={(path) => {
                if (!busy) void run(() => onUse(request.accountId, path), "Could not use that folder.");
              }}
            />
          )
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {!changing && !picking ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}>
                Use an existing folder…
              </Button>
              <Button
                size="sm"
                disabled={busy || request === null}
                onClick={() => request !== null && void run(() => onCreate(request.accountId), "Could not create the folder.")}
              >
                Create folder
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
