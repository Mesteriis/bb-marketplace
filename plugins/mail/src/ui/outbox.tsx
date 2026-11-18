// The Outbox: sends that are not done yet, at the top of the Sent list.
// Each row says where the send stands and offers only what is safe from
// there (the failure matrix): Undo while queued, Send now or Edit when held
// after a restart, Retry, Edit or Discard after a failure, Send again or
// Discard when it may have been sent, Retry copy or Dismiss when the Sent
// copy failed. A "Send later" row (slice 3l) waits for its time and offers
// Edit only: its Date is the picked time, so it is not sent early as it is.
// Nothing here resends on its own.
import type { OutboxRow, SendErrorKind } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatUntil, subjectOrPlaceholder } from "./thread-list.tsx";
import { dateLocale, msg, tx } from "./i18n/index.ts";

export type OutboxAction = "undo" | "send_now" | "edit" | "retry" | "resend" | "dismiss" | "retry_copy";

const ACTION_LABELS: Record<OutboxAction, string> = {
  undo: msg("Undo"),
  send_now: msg("Send now"),
  edit: msg("Edit"),
  retry: msg("Retry"),
  resend: msg("Send again"),
  dismiss: msg("Discard"),
  retry_copy: msg("Retry copy"),
};

/** What the owner may do with a row in its state; an unsubscribe request is never edited. */
export function outboxActions(
  row: Pick<OutboxRow, "state"> & Partial<Pick<OutboxRow, "purpose" | "scheduled">>,
): OutboxAction[] {
  if (row.state === "queued" && row.scheduled === true) return ["edit"];
  const actions = stateActions(row);
  // A send Mail wrote itself (an unsubscribe email, an invitation answer) has no draft to edit.
  return row.purpose != null ? actions.filter((action) => action !== "edit") : actions;
}

/** The row's title: its subject, or "Unsubscribe request" for the plugin's own unsubscribe email. */
export function outboxRowTitle(row: Pick<OutboxRow, "subject"> & Partial<Pick<OutboxRow, "purpose">>): string {
  return row.purpose === "unsubscribe" ? tx("Unsubscribe request") : subjectOrPlaceholder(row.subject);
}

function stateActions(row: Pick<OutboxRow, "state">): OutboxAction[] {
  switch (row.state) {
    case "queued":
      return ["undo"];
    case "held":
      return ["send_now", "edit"];
    case "failed":
      return ["retry", "edit", "dismiss"];
    case "unknown":
      return ["resend", "dismiss"];
    case "sent_no_copy":
      return ["retry_copy", "dismiss"];
    case "waiting":
      return ["send_now", "edit", "dismiss"];
    case "sending":
    case "sent":
    case "appending":
    case "done":
      return [];
  }
}

/** The label of an action on a row; Discard reads Dismiss once the message was sent. */
export function outboxActionLabel(row: Pick<OutboxRow, "state">, action: OutboxAction): string {
  if (action === "dismiss" && row.state === "sent_no_copy") return tx("Dismiss");
  return tx(ACTION_LABELS[action]);
}

/** A line under a row that says what its buttons keep and delete, or null. */
export function outboxRowHint(
  row: Pick<OutboxRow, "state"> & Partial<Pick<OutboxRow, "purpose" | "scheduled">>,
): string | null {
  if (row.state === "queued" && row.scheduled === true) return tx("Edit cancels the send and reopens the draft.");
  if (row.purpose === "unsubscribe") return row.state === "failed" || row.state === "unknown" || row.state === "waiting" ? tx("Discard deletes the request.") : null;
  if (row.purpose === "invite_reply") return row.state === "failed" || row.state === "unknown" || row.state === "waiting" ? tx("Discard deletes the answer.") : null;
  switch (row.state) {
    case "failed":
    case "waiting":
      return tx("Edit reopens the draft. Discard deletes the message and its draft.");
    case "unknown":
      return tx("Discard deletes the message and its draft.");
    default:
      return null;
  }
}

const REASONS: Record<SendErrorKind, string> = {
  auth: msg("sign-in refused"),
  tls: msg("the secure connection failed"),
  connect: msg("the server could not be reached"),
  timeout_before_data: msg("the server did not answer"),
  temporary: msg("the server asked to try again later"),
  rejected_all: msg("recipients refused"),
  rejected_message: msg("the server refused the message"),
  too_large: msg("too large for the server"),
  unknown_after_data: msg("the connection was lost while sending"),
  no_sent_folder: msg("no Sent folder to copy to"),
  sender_refused: msg("the server refused to send from this address"),
  append_failed: msg("the copy to Sent failed"),
  no_smtp: msg("this account has no outgoing server set"),
};

export function sendErrorText(kind: SendErrorKind): string {
  return tx(REASONS[kind]);
}

/** Where a send stands, in words. */
export function outboxStateText(
  row: Pick<OutboxRow, "state" | "errorKind" | "rejected"> & Partial<Pick<OutboxRow, "sendAfter" | "attempts" | "scheduled">>,
): string {
  const reason = row.errorKind !== null ? tx(REASONS[row.errorKind]) : null;
  switch (row.state) {
    case "queued":
      return row.scheduled === true && row.sendAfter !== undefined
        ? tx("Scheduled for {when}", { when: formatUntil(row.sendAfter) })
        : tx("Sending soon");
    case "held":
      return row.scheduled === true
        ? tx("Not sent: its time passed while BB was closed")
        : tx("Not sent: held after a restart");
    case "sending":
      return tx("Sending\u2026");
    case "sent":
    case "appending":
      return row.rejected.length > 0 ? tx("Sent, but not to: {p1}", { p1: row.rejected.join(", ") }) : tx("Sent; saving a copy to Sent\u2026");
    case "failed":
      return reason !== null ? tx("Not sent: {reason}", { reason }) : tx("Not sent");
    case "unknown":
      return tx("May have been sent");
    case "sent_no_copy":
      return reason !== null ? tx("Sent; {reason}", { reason }) : tx("Sent; the copy to Sent failed");
    case "done":
      return tx("Sent");
    case "waiting": {
      const why = reason !== null ? tx("Not sent yet: {reason}", { reason }) : tx("Not sent yet");
      const at = row.sendAfter !== undefined ? clockTime(row.sendAfter) : null;
      if (at === null) return `${why}. Mail will try again.`;
      const tries = row.attempts !== undefined && row.attempts > 0 ? ` (try ${row.attempts + 1})` : "";
      return `${why}. Next try at ${at}${tries}.`;
    }
  }
}

/** A time of day for an ISO date, or null when it does not parse. */
function clockTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
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
    <section aria-label={tx("Outbox")} className="shrink-0 border-b border-border">
      <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        <Icon name="Send" fallback="Mail" className="size-3.5" aria-hidden />
        {tx("Outbox")}
      </h3>
      <ul className="flex flex-col">
        {shown.map((row) => {
          const actions = outboxActions(row);
          const attention = row.state === "failed" || row.state === "unknown" || row.state === "sent_no_copy";
          const label = marker(row.accountId);
          const hint = outboxRowHint(row);
          return (
            <li
              key={row.id}
              aria-label={outboxRowTitle(row)}
              className="flex flex-col gap-1 px-3 py-2"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {outboxRowTitle(row)}
                </span>
                {row.origin === "agent" ? (
                  <span className="shrink-0 rounded-sm bg-secondary px-1 text-xs text-secondary-foreground">
                    {tx("Agent message")}
                  </span>
                ) : null}
                {label !== null ? (
                  <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
                    {label}
                  </span>
                ) : null}
              </div>
              <p className={cn("text-xs", attention ? "text-destructive" : "text-muted-foreground")}>
                {outboxStateText(row)}
              </p>
              {hint !== null ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
