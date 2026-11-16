// The one place in this plugin that can overwrite a skill the user edited.
//
// A conflict is deliberately not tickable: a checkbox next to five conflicts
// is one careless click away from losing five hand-written edits. So the
// route out is per skill and two-step — open this dialog from that one row,
// read both diffs, then say yes — and it is the only caller that ever sends
// `allowConflictOverwrite: true`.
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { SkillDiff, diffKey, type DiffKind, type DiffState } from "./skill-diff";

export function ConflictDialog({
  name,
  diffs,
  onRetryDiff,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The skill being resolved, or null when the dialog is closed. */
  name: string | null;
  diffs: Readonly<Record<string, DiffState>>;
  onRetryDiff: (name: string, kind: DiffKind, force?: boolean) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        // A pending overwrite must finish before the dialog can be dismissed.
        if (!open && !busy) onCancel();
      }}
    >
      {name === null ? null : (
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Replace your {name} with upstream</DialogTitle>
            <DialogDescription>
              Your edits to {name} are overwritten by the upstream version. Read
              both diffs below first: what you wrote is what you lose.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0">
            <SkillDiff
              label="Your changes — these go"
              state={diffs[diffKey(name, "local")]}
              onRetry={() => onRetryDiff(name, "local", true)}
            />
            <SkillDiff
              label="Upstream changes — these arrive"
              state={diffs[diffKey(name, "upstream")]}
              onRetry={() => onRetryDiff(name, "upstream", true)}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Keep my version
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={busy}>
              {busy ? (
                <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
              ) : null}
              Replace {name}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
