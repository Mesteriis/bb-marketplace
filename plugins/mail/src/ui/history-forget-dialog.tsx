// "Forget older mail" (slice 3h, #34): removes, from Mail only, a folder's
// loaded history and server search hits older than the sync window. The
// count is asked first (history_forget_check); opened messages stay.
import { useEffect, useState } from "react";
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

export interface ForgetRequest {
  accountId: string;
  folder: string;
  name: string;
}

/** The confirmation text for `count` messages. */
export function forgetText(count: number): string {
  if (count === 0) return "Nothing older than the sync window is kept for this folder.";
  const n = count === 1 ? "1 message" : `${count} messages`;
  return `Removes ${n} older than the sync window from Mail. Nothing changes on the server.`;
}

export function HistoryForgetDialog({
  request,
  count,
  error,
  onConfirm,
  onCancel,
}: {
  request: ForgetRequest | null;
  /** history_forget_check's count; null while it runs. */
  count: number | null;
  error: string | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setProblem(null);
  }, [request]);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>Forget older mail{request !== null ? ` in ${request.name}` : ""}</DialogTitle>
          <DialogDescription>Messages you opened stay.</DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : count === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {"Counting\u2026"}
          </p>
        ) : (
          <p className="text-sm text-foreground">{forgetText(count)}</p>
        )}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || count === null || count === 0} onClick={() => void confirm()}>
            {busy ? "Removing\u2026" : "Forget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
