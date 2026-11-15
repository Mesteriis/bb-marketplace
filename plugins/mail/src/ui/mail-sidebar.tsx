// The mail rail shown in BB's own sidebar while the Mail page is open: New
// message and the account chooser pinned at the top, then the merged roles
// (All accounts) or the account's folders with unread counts, the collapsible
// per-account groups, and the Outbox while sends are pending. It holds no
// mail state of its own: the page hands it what it shows and takes the
// owner's picks back.
import { useRef } from "react";
import type { Account, Folder, OutboxRow, RoleCount } from "../core/index.ts";
import { roleFolders } from "../core/actions.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  accountLabel,
  ALL_ACCOUNTS,
  FolderList,
  UnifiedRail,
  type MailView,
} from "./folder-list.tsx";
import { outboxAttention } from "./outbox.tsx";

/** What the sidebar draws; the Mail page publishes it. */
export interface MailSidebarState {
  /** False while the vault key is missing. */
  vaultReady: boolean;
  accounts: readonly Account[];
  /** All accounts is chosen. */
  unified: boolean;
  /** The chosen account; null in All accounts. */
  account: Account | null;
  /** The scope's folders; null while they load. */
  folders: readonly Folder[] | null;
  /** The merged roles with summed counts (All accounts only). */
  roles: readonly RoleCount[];
  foldersError: string | null;
  /** What the page lists. */
  view: MailView;
  /** Sends not done yet, of the accounts in scope. */
  outbox: readonly OutboxRow[];
}

export interface MailSidebarProps {
  /** null until the Mail page has loaded. */
  state: MailSidebarState | null;
  onCompose: () => void;
  /** An account id, or ALL_ACCOUNTS. */
  onSelectAccount: (choice: string) => void;
  onSelectView: (view: MailView) => void;
  /** The gear in the rail footer: Mail settings (sending addresses, signatures, templates). */
  onOpenSettings?: () => void;
}

function Notice({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

/** The account select (several accounts, with All accounts) or the account's name. */
function AccountChooser({
  state,
  onSelectAccount,
}: {
  state: MailSidebarState;
  onSelectAccount: (choice: string) => void;
}) {
  const { accounts, account } = state;
  // A pick hands focus to the Mail page; the select must not take it back.
  const picked = useRef(false);
  if (accounts.length > 1) {
    return (
      <Select
        value={state.unified ? ALL_ACCOUNTS : (account?.id ?? ALL_ACCOUNTS)}
        onValueChange={(choice) => {
          picked.current = true;
          onSelectAccount(choice);
        }}
      >
        <SelectTrigger aria-label="Account" className="h-8 w-full max-w-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(event) => {
            if (!picked.current) return;
            picked.current = false;
            event.preventDefault();
          }}
        >
          <SelectItem value={ALL_ACCOUNTS}>All accounts</SelectItem>
          {accounts.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {accountLabel(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const only = accounts[0];
  return (
    <span className="block truncate px-2 text-sm font-medium text-foreground">
      {only !== undefined ? accountLabel(only) : ""}
    </span>
  );
}

/** The view that holds the Outbox (Sent), or null when the account has no Sent folder yet. */
export function outboxView(state: Pick<MailSidebarState, "unified" | "account" | "folders">): MailView | null {
  if (state.unified) return { kind: "role", role: "sent" };
  const account = state.account;
  if (account === null) return null;
  const sent = roleFolders("sent", (state.folders ?? []).filter((f) => f.accountId === account.id)).find(
    (f) => f.selectable,
  );
  return sent === undefined ? null : { kind: "folder", accountId: account.id, path: sent.path };
}

/** The Outbox row: pending sends, opening Sent where the Outbox is listed. */
function OutboxRowButton({
  rows,
  target,
  onSelect,
}: {
  rows: readonly OutboxRow[];
  target: MailView;
  onSelect: (view: MailView) => void;
}) {
  const attention = outboxAttention(rows);
  return (
    <ul aria-label="Outbox" className="flex flex-col gap-px px-1.5 py-1">
      <li>
        <button
          type="button"
          onClick={() => onSelect(target)}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon name="Send" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Outbox</span>
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              attention > 0 ? "rounded-sm bg-destructive/10 px-1 text-destructive" : "text-muted-foreground",
            )}
          >
            {rows.length}
            <span className="sr-only">{attention > 0 ? ` sends, ${attention} need you` : " sends"}</span>
          </span>
        </button>
      </li>
    </ul>
  );
}

export function MailSidebar({ state, onCompose, onSelectAccount, onSelectView, onOpenSettings }: MailSidebarProps) {
  const body = (() => {
    if (state === null) return <Notice>Loading mail…</Notice>;
    if (!state.vaultReady) return <Notice>Mail is not set up yet.</Notice>;
    if (state.accounts.length === 0) return <Notice>No mail account yet.</Notice>;
    const attention = outboxAttention(state.outbox);
    const toOutbox = state.outbox.length > 0 ? outboxView(state) : null;
    return (
      <>
        <div className="flex shrink-0 flex-col gap-1.5 px-1.5 pb-1.5 pt-2">
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={onCompose}>
            <Icon name="Pencil" fallback="Plus" aria-hidden />
            New message
          </Button>
          <AccountChooser state={state} onSelectAccount={onSelectAccount} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {state.unified ? (
            <UnifiedRail
              roles={state.roles}
              folders={state.folders ?? []}
              accounts={state.accounts}
              view={state.view}
              onSelect={onSelectView}
              error={state.foldersError}
              sentAttention={attention}
            />
          ) : state.account !== null ? (
            <FolderList
              folders={state.folders ?? []}
              selectedPath={state.view.kind === "folder" ? state.view.path : ""}
              onSelect={(path) => onSelectView({ kind: "folder", accountId: state.account!.id, path })}
              error={state.foldersError}
              sentAttention={attention}
            />
          ) : null}
          {toOutbox !== null ? (
            <OutboxRowButton rows={state.outbox} target={toOutbox} onSelect={onSelectView} />
          ) : null}
        </div>
        {onOpenSettings !== undefined ? (
          <div className="flex shrink-0 items-center border-t border-border px-1.5 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start px-2 text-muted-foreground"
              onClick={onOpenSettings}
            >
              <Icon name="Settings" fallback="Info" aria-hidden />
              Mail settings
            </Button>
          </div>
        ) : null}
      </>
    );
  })();
  return (
    <nav aria-label="Folders" className="flex h-full min-h-0 min-w-0 flex-col">
      {body}
    </nav>
  );
}
