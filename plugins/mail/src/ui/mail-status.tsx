// Sync status for the owner (slice 3j, #48): the header's short label, the
// problems of each account in words, and the Mail status panel. A lost
// network is quiet ("Offline") while the last good sync is recent; anything
// the owner has to fix is a banner. Problems are read from the account's
// stored line by `parseSyncProblems`; folder names in them are data.
import type { Account, OutboxRow } from "../core/index.ts";
import { isQuietlyOffline, parseSyncProblems, syncProblemText } from "../core/sync-problems.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { accountLabel } from "./folder-list.tsx";
import { stopEscape } from "./shortcuts.ts";
import { formatFullDate, formatListDate } from "./thread-list.tsx";

/** The page's own link to BB, as the host reports it. */
export type BbLink = "connected" | "connecting" | "reconnecting";

type StatusAccount = Pick<
  Account,
  "id" | "email" | "displayName" | "lastSyncAt" | "lastError" | "authFailed"
>;

/** Accounts whose trouble needs the owner: a banner each. */
export function accountsNeedingAttention<T extends StatusAccount>(accounts: readonly T[], nowMs: number): T[] {
  return accounts.filter((a) => a.lastError !== null && !isQuietlyOffline(a, nowMs));
}

/** The account's problems as sentences, each once. */
export function accountProblemTexts(account: Pick<Account, "lastError">): string[] {
  return [...new Set(parseSyncProblems(account.lastError).map(syncProblemText))];
}

/** The header's label: syncing, the BB link, offline, or when mail was last synced. */
export function syncStatusLabel(
  accounts: readonly StatusAccount[],
  syncing: boolean,
  nowMs: number,
  bbLink: BbLink = "connected",
): string {
  if (bbLink === "reconnecting") return "Reconnecting to BB…";
  if (syncing) return "Syncing…";
  if (accounts.length === 0 || accounts.some((a) => a.lastSyncAt === null)) return "Not synced yet";
  const oldest = accounts.map((a) => a.lastSyncAt!).sort()[0]!;
  const when = formatListDate(oldest, new Date(nowMs));
  return accounts.some((a) => isQuietlyOffline(a, nowMs)) ? `Offline · synced ${when}` : `Synced ${when}`;
}

export interface MailStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly StatusAccount[];
  outbox: readonly Pick<OutboxRow, "accountId" | "state">[];
  syncing: boolean;
  onSync: () => void;
  nowMs: number;
  bbLink?: BbLink;
}

/** What stands in the Outbox for an account, in words; null when nothing does. */
export function outboxStatusText(rows: readonly Pick<OutboxRow, "state">[]): string | null {
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const stuck = rows.filter((r) => r.state === "failed" || r.state === "unknown" || r.state === "held").length;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting to be sent`);
  if (stuck > 0) parts.push(`${stuck} not sent`);
  return parts.length > 0 ? `Outbox: ${parts.join(", ")}` : null;
}

/** Mail status: each account's last sync, its problems and its waiting sends. Read-only besides Sync now. */
export function MailStatusDialog(props: MailStatusDialogProps) {
  const { accounts, nowMs } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>Mail status</DialogTitle>
          <DialogDescription>
            {props.bbLink === "reconnecting"
              ? "This page lost its link to BB and is reconnecting."
              : "When each account was last synced, and what is in the way."}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {accounts.map((account) => {
            const problems = accountProblemTexts(account);
            const offline = isQuietlyOffline(account, nowMs);
            const sends = outboxStatusText(props.outbox.filter((row) => row.accountId === account.id));
            return (
              <li key={account.id} aria-label={accountLabel(account)} className="flex flex-col gap-1 text-sm">
                <span className="truncate font-medium text-foreground">{accountLabel(account)}</span>
                <span className="text-xs text-muted-foreground">
                  {account.lastSyncAt === null ? "Not synced yet" : `Synced ${formatFullDate(account.lastSyncAt)}`}
                  {offline ? " · offline, Mail keeps trying" : ""}
                </span>
                {problems.map((text) => (
                  <span key={text} className={offline ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                    {text}
                  </span>
                ))}
                {sends !== null ? <span className="text-xs text-muted-foreground">{sends}</span> : null}
              </li>
            );
          })}
          {accounts.length === 0 ? <li className="text-sm text-muted-foreground">No accounts yet.</li> : null}
        </ul>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={props.syncing} onClick={props.onSync}>
            {props.syncing ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
