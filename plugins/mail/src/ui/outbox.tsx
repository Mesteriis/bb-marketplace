// The Outbox: sends that are not done yet, at the top of the Sent list.
// Each row says where the send stands and offers only what is safe from
// there (the failure matrix): Undo while queued, Send now or Edit when held
// after a restart, Retry after a failure, Send again or Discard when it may
// have been sent, Retry copy or Dismiss when the Sent copy failed. Nothing
// here resends on its own.
import type { OutboxRow, SendErrorKind } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { subjectOrPlaceholder } from "./thread-list.tsx";

export type OutboxAction = "undo" | "send_now" | "edit" | "retry" | "resend" | "dismiss" | "retry_copy";

const ACTION_LABELS: Record<OutboxAction, string> = {
  undo: "Undo",
  send_now: "Send now",
  edit: "Edit",
  retry: "Retry",
  resend: "Send again",
  dismiss: "Discard",
  retry_copy: "Retry copy",
};

/** What the owner may do with a row in its state. */
export function outboxActions(row: Pick<OutboxRow, "state">): OutboxAction[] {
  switch (row.state) {
    case "queued":
      return ["undo"];
    case "held":
      return ["send_now", "edit"];
    case "failed":
      return ["retry"];
    case "unknown":
      return ["resend", "dismiss"];
    case "sent_no_copy":
      return ["retry_copy", "dismiss"];
    case "sending":
    case "sent":
    case "appending":
    case "done":
      return [];
  }
}

/** The label of an action on a row; Discard reads Dismiss once the message was sent. */
export function outboxActionLabel(row: Pick<OutboxRow, "state">, action: OutboxAction): string {
  if (action === "dismiss" && row.state === "sent_no_copy") return "Dismiss";
  return ACTION_LABELS[action];
}

const REASONS: Record<SendErrorKind, string> = {
  auth: "sign-in refused",
  tls: "the secure connection failed",
  connect: "the server could not be reached",
  timeout_before_data: "the server did not answer",
  temporary: "the server asked to try again later",
  rejected_all: "recipients refused",
  rejected_message: "the server refused the message",
  too_large: "too large for the server",
  unknown_after_data: "the connection was lost while sending",
  no_sent_folder: "no Sent folder to copy to",
  append_failed: "the copy to Sent failed",
};

export function sendErrorText(kind: SendErrorKind): string {
  return REASONS[kind];
}

/** Where a send stands, in words. */
export function outboxStateText(row: Pick<OutboxRow, "state" | "errorKind" | "rejected">): string {
  const reason = row.errorKind !== null ? REASONS[row.errorKind] : null;
  switch (row.state) {
    case "queued":
      return "Sending soon";
    case "held":
      return "Not sent: held after a restart";
    case "sending":
      return "Sending…";
    case "sent":
    case "appending":
      return row.rejected.length > 0 ? `Sent, but not to: ${row.rejected.join(", ")}` : "Sent; saving a copy to Sent…";
    case "failed":
      return reason !== null ? `Not sent: ${reason}` : "Not sent";
    case "unknown":
      return "May have been sent";
    case "sent_no_copy":
      return reason !== null ? `Sent; ${reason}` : "Sent; the copy to Sent failed";
    case "done":
      return "Sent";
  }
}

/** Rows that need the owner: shown as a count on Sent in the folder rail. */
export function outboxAttention(rows: readonly Pick<OutboxRow, "state">[]): number {
  return rows.filter((row) => row.state === "failed" || row.state === "unknown" || row.state === "held").length;
}

export interface OutboxSectionProps {
  rows: readonly OutboxRow[];
  onAction: (row: OutboxRow, action: OutboxAction) => void;
  /** An action is in flight for these row ids. */
  pending: ReadonlySet<string>;
  /** Labels rows in All accounts; null for one account. */
  marker: (accountId: string) => string | null;
}

export function OutboxSection({ rows, onAction, pending, marker }: OutboxSectionProps) {
  const shown = rows.filter((row) => row.state !== "done");
  if (shown.length === 0) return null;
  return (
    <section aria-label="Outbox" className="shrink-0 border-b border-border">
      <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        <Icon name="Send" fallback="Mail" className="size-3.5" aria-hidden />
        Outbox
      </h3>
      <ul className="flex flex-col">
        {shown.map((row) => {
          const actions = outboxActions(row);
          const attention = row.state === "failed" || row.state === "unknown" || row.state === "sent_no_copy";
          const label = marker(row.accountId);
          return (
            <li
              key={row.id}
              aria-label={subjectOrPlaceholder(row.subject)}
              className="flex flex-col gap-1 px-3 py-2"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {subjectOrPlaceholder(row.subject)}
                </span>
                {label !== null ? (
                  <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
                    {label}
                  </span>
                ) : null}
              </div>
              <p className={cn("text-xs", attention ? "text-destructive" : "text-muted-foreground")}>
                {outboxStateText(row)}
              </p>
              {actions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {actions.map((action) => (
                    <Button
                      key={action}
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={pending.has(row.id)}
                      onClick={() => onAction(row, action)}
                    >
                      {outboxActionLabel(row, action)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
