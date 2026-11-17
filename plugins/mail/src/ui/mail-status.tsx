// Sync status for the owner (slice 3j, #48): the header's short label, the
// problems of each account in words, and the Mail status panel. A lost
// network is quiet ("Offline") while the last good sync is recent; anything
// the owner has to fix is a banner. Problems are read from the account's
// stored line by `parseSyncProblems`; folder names in them are data.
import type { Account, OutboxRow } from "../core/index.ts";
import { isQuietlyOffline, parseSyncProblems, type SyncProblem } from "../core/sync-problems.ts";
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
import { tx } from "./i18n/index.ts";

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

/** One problem as a sentence in the page's language; the folder, the count and the code go in as values. */
export function problemShown(p: SyncProblem): string {
  const where = p.folder !== null ? `${p.folder}: ` : "";
  const code = p.detail !== null ? ` (${p.detail})` : "";
  const folder = p.folder ?? "";
  const count = p.count ?? 0;
  switch (p.code) {
    case "auth_failed":
      return where + tx("The server refused the sign-in. Update the app password.");
    case "credential_unreadable":
      return tx("The saved password cannot be read. Enter it again.");
    case "network":
      return where + tx("The mail server could not be reached{code}.", { code });
    case "server_busy":
      return where + tx("The mail server is busy and asked to try later{code}.", { code });
    case "tls":
      return where + tx("The secure connection to the mail server failed{code}.", { code });
    case "server":
      return where + tx("Sync failed{code}.", { code });
    case "folder_gone_moves_dropped":
      return tx("{folder} no longer exists on the server; {count} queued moves were dropped.", { folder, count });
    case "renumbered_moves_dropped":
      return tx("{folder} was renumbered by the server; {count} queued moves were dropped.", { folder, count });
    case "flags_not_saved":
      return where + tx("Read and flag changes could not be saved on the server.");
    case "moves_returned":
      return tx("{count} messages could not be moved; they are back in {folder}.", { count, folder });
    case "other":
      return p.detail ?? tx("Sync failed{code}.", { code: "" });
  }
}

/** The account's problems as sentences, each once. */
export function accountProblemTexts(account: Pick<Account, "lastError">): string[] {
  return [...new Set(parseSyncProblems(account.lastError).map(problemShown))];
}

/** The header's label: syncing, the BB link, offline, or when mail was last synced. */
export function syncStatusLabel(
  accounts: readonly StatusAccount[],
  syncing: boolean,
  nowMs: number,
  bbLink: BbLink = "connected",
): string {
  if (bbLink === "reconnecting") return tx("Reconnecting to BB\u2026");
  if (syncing) return tx("Syncing\u2026");
  if (accounts.length === 0 || accounts.some((a) => a.lastSyncAt === null)) return tx("Not synced yet");
  const oldest = accounts.map((a) => a.lastSyncAt!).sort()[0]!;
  const when = formatListDate(oldest, new Date(nowMs));
  return accounts.some((a) => isQuietlyOffline(a, nowMs)) ? tx("Offline \u00b7 synced {when}", { when }) : tx("Synced {when}", { when });
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
  if (waiting > 0) parts.push(tx("{waiting} waiting to be sent", { waiting }));
  if (stuck > 0) parts.push(tx("{stuck} not sent", { stuck }));
  return parts.length > 0 ? tx("Outbox: {p1}", { p1: parts.join(", ") }) : null;
}

/** Mail status: each account's last sync, its problems and its waiting sends. Read-only besides Sync now. */
export function MailStatusDialog(props: MailStatusDialogProps) {
  const { accounts, nowMs } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{tx("Mail status")}</DialogTitle>
          <DialogDescription>
            {props.bbLink === "reconnecting"
              ? tx("This page lost its link to BB and is reconnecting.")
              : tx("When each account was last synced, and what is in the way.")}
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
                  {account.lastSyncAt === null ? tx("Not synced yet") : `Synced ${formatFullDate(account.lastSyncAt)}`}
                  {offline ? tx(" \u00b7 offline, Mail keeps trying") : ""}
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
          {accounts.length === 0 ? <li className="text-sm text-muted-foreground">{tx("No accounts yet.")}</li> : null}
        </ul>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={props.syncing} onClick={props.onSync}>
            {props.syncing ? tx("Syncing\u2026") : tx("Sync now")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
