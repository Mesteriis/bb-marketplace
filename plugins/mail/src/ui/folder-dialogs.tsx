// Folder management dialogs (slice 3h, #49): New folder..., Rename... and
// Delete.... Delete asks the server first (folder_delete_check): an empty
// folder goes after one confirmation; a non-empty one offers to move its
// mail to Trash first (not undoable, and the dialog says so); a Gmail label
// is removed with its messages left in All Mail (spec resolution 5). The
// server repeats every check; the texts here come from its answer.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { FOLDER_NAME_MAX, validFolderName, type FolderNameRefusal, type FolderOpRefusal } from "../core/folder-ops.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { stopEscape } from "./shortcuts.ts";

export const FOLDER_NAME_TEXT: Record<FolderNameRefusal, string> = {
  empty: "Type a name",
  too_long: `Use at most ${FOLDER_NAME_MAX} characters`,
  control: "The name has characters a folder cannot hold",
  delimiter: "The name cannot hold the folder separator",
  reserved: "That name is reserved",
  exists: "A folder with that name is already here",
  special_use: "That name is used for system folders",
};

/** Why a folder cannot be renamed or deleted, as the owner reads it. */
export function folderRefusalText(refusal: FolderOpRefusal, op: "rename" | "delete"): string {
  switch (refusal) {
    case "inbox":
    case "special_use":
      return op === "delete" ? "Inbox and system folders cannot be deleted" : "Inbox and system folders cannot be renamed";
    case "gmail_system":
      return "Gmail's own folders cannot be changed";
    case "snooze_folder":
      return "This is the snooze folder; choose another one in Mail settings first";
    case "has_children":
      return "Delete its subfolders first";
    case "move_pending":
      return "Messages are still moving in or out of this folder; try again in a moment";
    case "parent_not_selectable":
      return "This folder cannot be renamed here";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A new folder (parent null: at the top of the account) or a rename. */
export type FolderNameRequest =
  | { kind: "create"; accountId: string; accountLabel: string; parent: { path: string; name: string } | null; siblings: readonly string[] }
  | { kind: "rename"; accountId: string; path: string; name: string; siblings: readonly string[] };

function NameForm({
  request,
  onSubmit,
  onCancel,
}: {
  request: FolderNameRequest;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(request.kind === "rename" ? request.name : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const siblings = request.siblings.filter((s) => request.kind !== "rename" || s !== request.name);
    // The delimiter and the special-use names are the server's; it checks them again.
    const checked = validFolderName(name, { delimiter: "", siblings, namedLikeSpecialUse: () => false });
    if (!checked.ok) {
      setProblem(FOLDER_NAME_TEXT[checked.reason]);
      return;
    }
    if (request.kind === "rename" && checked.name === request.name) {
      onCancel();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(checked.name);
    } catch (error) {
      setProblem(errorText(error));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <Input
        aria-label="Folder name"
        autoFocus
        value={name}
        maxLength={FOLDER_NAME_MAX + 20}
        onChange={(event) => setName(event.target.value)}
      />
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {request.kind === "create" ? (busy ? "Creating\u2026" : "Create") : busy ? "Renaming\u2026" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function FolderNameDialog({
  request,
  onCreate,
  onRename,
  onCancel,
}: {
  request: FolderNameRequest | null;
  onCreate: (accountId: string, parent: string | null, name: string) => Promise<void>;
  onRename: (accountId: string, path: string, name: string) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        {request !== null ? (
          <>
            <DialogHeader>
              <DialogTitle>{request.kind === "create" ? (request.parent === null ? "New folder" : "New subfolder") : "Rename folder"}</DialogTitle>
              <DialogDescription>
                {request.kind === "create"
                  ? request.parent === null
                    ? `A new folder in ${request.accountLabel}, on the mail server.`
                    : `A new folder inside ${request.parent.name}, on the mail server.`
                  : `Renames ${request.name} on the mail server.`}
              </DialogDescription>
            </DialogHeader>
            <NameForm
              key={request.kind === "rename" ? request.path : (request.parent?.path ?? "")}
              request={request}
              onCancel={onCancel}
              onSubmit={(name) =>
                request.kind === "create"
                  ? onCreate(request.accountId, request.parent?.path ?? null, name)
                  : onRename(request.accountId, request.path, name)
              }
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** folder_delete_check's answer. */
export interface DeleteCheck {
  messages: number;
  children: number;
  gmailLabel: boolean;
  refusal: FolderOpRefusal | null;
}

export interface DeleteRequest {
  accountId: string;
  path: string;
  name: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the delete dialog says and offers for a check. */
export function deletePlan(name: string, check: DeleteCheck):
  | { kind: "refused"; text: string }
  | { kind: "empty"; text: string }
  | { kind: "gmail"; text: string; messages: number }
  | { kind: "move"; text: string; messages: number } {
  if (check.refusal !== null) return { kind: "refused", text: folderRefusalText(check.refusal, "delete") };
  if (check.gmailLabel) {
    return {
      kind: "gmail",
      messages: check.messages,
      text:
        check.messages === 0
          ? `Delete the label ${name}? No message has it. The label is removed from Gmail.`
          : `Delete the label ${name}? It is removed from ${plural(check.messages, "message", "messages")}. The messages stay in All Mail and keep their other labels.`,
    };
  }
  if (check.messages === 0) return { kind: "empty", text: `Delete ${name}? It is empty.` };
  return {
    kind: "move",
    messages: check.messages,
    text: `${name} has ${plural(check.messages, "message", "messages")}. Move them to Trash first?`,
  };
}

/** The move step cannot be undone with Undo; the messages are in Trash. */
export const MOVE_NOT_UNDO_TEXT = "Undo does not bring them back here; they will be in Trash.";

export function DeleteFolderDialog({
  request,
  check,
  checkError,
  onDelete,
  onCancel,
}: {
  request: DeleteRequest | null;
  /** folder_delete_check's answer; null while it runs. */
  check: DeleteCheck | null;
  checkError: string | null;
  /** Resolves when the folder is gone; rejects with the server's refusal text. */
  onDelete: (input: { moveToTrash: boolean; expectedMessages: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setProblem(null);
  }, [request, check]);

  const run = async (input: { moveToTrash: boolean; expectedMessages: number }) => {
    setBusy(true);
    setProblem(null);
    try {
      await onDelete(input);
    } catch (error) {
      setProblem(errorText(error));
      setBusy(false);
    }
  };

  let body: ReactNode = null;
  let action: ReactNode = null;
  if (request !== null) {
    if (checkError !== null) {
      body = (
        <p role="alert" className="text-sm text-destructive">
          {checkError}
        </p>
      );
    } else if (check === null) {
      body = (
        <p role="status" className="text-sm text-muted-foreground">
          {"Checking the folder on the server\u2026"}
        </p>
      );
    } else {
      const plan = deletePlan(request.name, check);
      body = <p className="text-sm text-foreground">{plan.text}</p>;
      if (plan.kind === "empty") {
        action = (
          <Button variant="destructive" disabled={busy} onClick={() => void run({ moveToTrash: false, expectedMessages: 0 })}>
            {busy ? "Deleting\u2026" : "Delete"}
          </Button>
        );
      } else if (plan.kind === "gmail") {
        action = (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void run({ moveToTrash: false, expectedMessages: plan.messages })}
          >
            {busy ? "Deleting\u2026" : "Delete label"}
          </Button>
        );
      } else if (plan.kind === "move") {
        body = (
          <>
            {body}
            <p className="text-xs text-muted-foreground">{MOVE_NOT_UNDO_TEXT}</p>
          </>
        );
        action = (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void run({ moveToTrash: true, expectedMessages: plan.messages })}
          >
            {busy ? "Moving\u2026" : `Move ${plan.messages} to Trash, then delete`}
          </Button>
        );
      }
    }
  }
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{request !== null ? `Delete ${request.name}` : "Delete folder"}</DialogTitle>
          <DialogDescription>Deleting a folder changes the mail server, not only Mail.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">{body}</div>
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {action === null ? "Done" : "Cancel"}
          </Button>
          {action}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
