// The mail rail shown in BB's own sidebar while the Mail page is open: New
// message and the account chooser pinned at the top, then the merged roles
// (All accounts) or the account's folders with unread counts, the collapsible
// per-account groups, and the Outbox while sends are pending. It holds no
// mail state of its own: the page hands it what it shows and takes the
// owner's picks back. Slice 3h adds Files, the Saved section, folder and
// account menus, More folders and drop targets; the menus' picks go to the
// page as commands, which opens its dialogs.
import { useRef, useState } from "react";
import type { Account, Folder, OutboxRow, RoleCount, SavedSearchView } from "../core/index.ts";
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
  type RailExtras,
  type RoleName,
} from "./folder-list.tsx";
import { outboxAttention } from "./outbox.tsx";
import { ActionMenu, type MenuEntry } from "./action-menu.tsx";
import { SavedSearchesRail } from "./saved-searches.tsx";
import { tx } from "./i18n/index.ts";

/** A rail page: Today and Tasks (slice 3f), Dev and Projects (slice 3g), Files (slice 3h). */
export type RailPage = "today" | "tasks" | "dev" | "projects" | "files";

/** Slice 3h: what a folder, account or saved search menu asks of the page. */
export type RailCommand =
  | { kind: "folder_new"; accountId: string; parent: string | null }
  | { kind: "folder_rename"; accountId: string; path: string }
  | { kind: "folder_delete"; accountId: string; path: string }
  | { kind: "folder_subscribe"; accountId: string; path: string; subscribed: boolean }
  | { kind: "folder_grouping"; accountId: string; path: string; grouping: boolean }
  | { kind: "history_forget"; accountId: string; path: string }
  | { kind: "saved_open"; id: string }
  | { kind: "saved_rename" | "saved_edit" | "saved_delete" | "saved_up" | "saved_down"; id: string }
  | { kind: "drop"; accountId: string; path: string; raw: string }
  | { kind: "drop_role"; role: RoleName; raw: string };

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
  /** Slice 3f: the Today and Tasks entries with their counts (null while unknown), and the one open. */
  pages?: {
    today: number | null;
    tasks: number | null;
    current: RailPage | null;
    /** Slice 3g: Dev (CI failures of the last day) and Projects; absent: not shown. */
    dev?: number | null;
    projects?: boolean;
    /** Slice 3h: Files. */
    files?: boolean;
  };
  /** Slice 3h: saved searches and the one open; absent: no Saved section. */
  saved?: { searches: readonly SavedSearchView[]; currentId: string | null };
  /** Slice 3h: folder grouping per folder (default on). */
  grouped?: (accountId: string, path: string) => boolean;
  /** Slice 3h: the accounts of the conversations being dragged; null when none is. */
  dragAccounts?: readonly string[] | null;
  /** Slice 3h: Gmail accounts (a label folder's menu says label). */
  gmailAccounts?: readonly string[];
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
  /** Today or Tasks (slice 3f), Dev or Projects (slice 3g), Files (slice 3h). */
  onSelectPage?: (page: RailPage) => void;
  /** Slice 3h: menu picks, saved searches and drops; absent: no menus, no Saved, no drops. */
  onRailCommand?: (command: RailCommand) => void;
}

/** The Today and Tasks entries (slice 3f). */
function PageRows({
  pages,
  onSelect,
}: {
  pages: NonNullable<MailSidebarState["pages"]>;
  onSelect: (page: RailPage) => void;
}) {
  const rows: { page: RailPage; label: string; icon: string; count: number | null; unit: string }[] = [
    { page: "today", label: "Today", icon: "Sun", count: pages.today, unit: "need a reply" },
    { page: "tasks", label: "Tasks", icon: "ListChecks", count: pages.tasks, unit: "open" },
    ...(pages.dev !== undefined ? [{ page: "dev" as const, label: "Dev", icon: "GitBranch", count: pages.dev, unit: "CI failures today" }] : []),
    ...(pages.projects === true ? [{ page: "projects" as const, label: "Projects", icon: "Folder", count: null, unit: "" }] : []),
    ...(pages.files === true ? [{ page: "files" as const, label: "Files", icon: "Paperclip", count: null, unit: "" }] : []),
  ];
  return (
    <ul aria-label={tx("Today and tasks")} className="flex flex-col gap-px px-1.5 pb-1">
      {rows.map((row) => (
        <li key={row.page}>
          <button
            type="button"
            aria-current={pages.current === row.page ? "page" : undefined}
            onClick={() => onSelect(row.page)}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              pages.current === row.page && "bg-state-active",
            )}
          >
            <Icon name={row.icon} fallback="Check" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.count !== null && row.count > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {row.count}
                <span className="sr-only">{` ${row.unit}`}</span>
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
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
        <SelectTrigger aria-label={tx("Account")} className="h-8 w-full max-w-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(event) => {
            if (!picked.current) return;
            picked.current = false;
            event.preventDefault();
          }}
        >
          <SelectItem value={ALL_ACCOUNTS}>{tx("All accounts")}</SelectItem>
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
    <ul aria-label={tx("Outbox")} className="flex flex-col gap-px px-1.5 py-1">
      <li>
        <button
          type="button"
          onClick={() => onSelect(target)}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon name="Send" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{tx("Outbox")}</span>
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

type OpenMenu =
  | { kind: "folder"; folder: Folder }
  | { kind: "account"; account: Account }
  | { kind: "saved"; search: SavedSearchView; index: number; count: number };

/** The entries of a folder's menu. */
export function folderMenuEntries(folder: Folder, grouped: boolean, gmail: boolean): MenuEntry[] {
  const own = folder.specialUse === null && folder.path.toUpperCase() !== "INBOX";
  const entries: MenuEntry[] = [{ kind: "action", id: "new", label: "New subfolder\u2026", icon: "FolderPlus" }];
  if (own) entries.push({ kind: "action", id: "rename", label: "Rename\u2026", icon: "Pencil" });
  entries.push({ kind: "check", id: "subscribe", label: "Subscribed", checked: folder.subscribed });
  entries.push({ kind: "check", id: "grouping", label: "Group by conversation", checked: grouped });
  entries.push({ kind: "action", id: "forget", label: "Forget older mail\u2026", icon: "Eraser" });
  if (own) {
    entries.push({ kind: "action", id: "delete", label: gmail ? "Delete label\u2026" : "Delete\u2026", icon: "Trash2", destructive: true });
  }
  return entries;
}

export function MailSidebar({ state, onCompose, onSelectAccount, onSelectView, onOpenSettings, onSelectPage, onRailCommand }: MailSidebarProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const extras: RailExtras | undefined =
    onRailCommand === undefined || state === null
      ? undefined
      : {
          onMenu: (folder) => setMenu({ kind: "folder", folder }),
          drop: {
            accepts: (folder) => {
              const dragging = state.dragAccounts ?? null;
              return dragging === null || (dragging.length === 1 && dragging[0] === folder.accountId);
            },
            onDrop: (folder, raw) => onRailCommand({ kind: "drop", accountId: folder.accountId, path: folder.path, raw }),
            onRoleDrop: (role, raw) => onRailCommand({ kind: "drop_role", role, raw }),
          },
        };
  const menuView = (() => {
    if (menu === null || onRailCommand === undefined || state === null) return null;
    if (menu.kind === "folder") {
      const { folder } = menu;
      const grouped = state.grouped?.(folder.accountId, folder.path) ?? true;
      const gmail = state.gmailAccounts?.includes(folder.accountId) === true;
      return {
        title: folder.name,
        entries: folderMenuEntries(folder, grouped, gmail),
        pick: (id: string) => {
          const at = { accountId: folder.accountId, path: folder.path };
          if (id === "new") onRailCommand({ kind: "folder_new", accountId: folder.accountId, parent: folder.path });
          else if (id === "rename") onRailCommand({ kind: "folder_rename", ...at });
          else if (id === "delete") onRailCommand({ kind: "folder_delete", ...at });
          else if (id === "subscribe") onRailCommand({ kind: "folder_subscribe", ...at, subscribed: !folder.subscribed });
          else if (id === "grouping") onRailCommand({ kind: "folder_grouping", ...at, grouping: !grouped });
          else if (id === "forget") onRailCommand({ kind: "history_forget", ...at });
        },
      };
    }
    if (menu.kind === "account") {
      return {
        title: accountLabel(menu.account),
        entries: [{ kind: "action", id: "new", label: "New folder\u2026", icon: "FolderPlus" }] as MenuEntry[],
        pick: () => onRailCommand({ kind: "folder_new", accountId: menu.account.id, parent: null }),
      };
    }
    const { search, index, count } = menu;
    return {
      title: search.name,
      entries: [
        { kind: "action", id: "saved_rename", label: "Rename\u2026", icon: "Pencil" },
        { kind: "action", id: "saved_edit", label: "Edit query\u2026", icon: "Search" },
        { kind: "action", id: "saved_up", label: "Move up", icon: "ArrowUp", disabled: index === 0 },
        { kind: "action", id: "saved_down", label: "Move down", icon: "ArrowDown", disabled: index === count - 1 },
        { kind: "action", id: "saved_delete", label: "Delete", icon: "Trash2", destructive: true },
      ] as MenuEntry[],
      pick: (id: string) =>
        onRailCommand({ kind: id as "saved_rename" | "saved_edit" | "saved_delete" | "saved_up" | "saved_down", id: search.id }),
    };
  })();
  const body = (() => {
    if (state === null) return <Notice>{tx("Loading mail\u2026")}</Notice>;
    if (!state.vaultReady) return <Notice>{tx("Mail is not set up yet.")}</Notice>;
    if (state.accounts.length === 0) return <Notice>{tx("No mail account yet.")}</Notice>;
    const attention = outboxAttention(state.outbox);
    const toOutbox = state.outbox.length > 0 ? outboxView(state) : null;
    return (
      <>
        <div className="flex shrink-0 flex-col gap-1.5 px-1.5 pb-1.5 pt-2">
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={onCompose}>
            <Icon name="Pencil" fallback="Plus" aria-hidden />
            {tx("New message")}
          </Button>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <AccountChooser state={state} onSelectAccount={onSelectAccount} />
            </div>
            {onRailCommand !== undefined && !state.unified && state.account !== null ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label={tx("Account options")}
                onClick={() => setMenu({ kind: "account", account: state.account! })}
              >
                <Icon name="MoreHorizontal" fallback="Info" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {state.pages !== undefined && onSelectPage !== undefined ? (
            <PageRows pages={state.pages} onSelect={onSelectPage} />
          ) : null}
          {state.saved !== undefined && onRailCommand !== undefined ? (
            <SavedSearchesRail
              searches={state.saved.searches}
              currentId={state.saved.currentId}
              onOpen={(search) => onRailCommand({ kind: "saved_open", id: search.id })}
              onMenu={(search) => {
                const searches = state.saved?.searches ?? [];
                setMenu({ kind: "saved", search, index: searches.indexOf(search), count: searches.length });
              }}
            />
          ) : null}
          {state.unified ? (
            <UnifiedRail
              roles={state.roles}
              folders={state.folders ?? []}
              accounts={state.accounts}
              view={state.view}
              onSelect={onSelectView}
              error={state.foldersError}
              sentAttention={attention}
              {...(extras !== undefined ? { extras, onAccountMenu: (account: Account) => setMenu({ kind: "account", account }) } : {})}
            />
          ) : state.account !== null ? (
            <FolderList
              folders={state.folders ?? []}
              selectedPath={state.view.kind === "folder" ? state.view.path : ""}
              onSelect={(path) => onSelectView({ kind: "folder", accountId: state.account!.id, path })}
              error={state.foldersError}
              sentAttention={attention}
              {...(extras !== undefined ? { extras } : {})}
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
              {tx("Mail settings")}
            </Button>
          </div>
        ) : null}
      </>
    );
  })();
  return (
    <nav aria-label={tx("Folders")} className="flex h-full min-h-0 min-w-0 flex-col">
      {body}
      {menuView !== null ? (
        <ActionMenu
          open
          title={menuView.title}
          entries={menuView.entries}
          onPick={menuView.pick}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </nav>
  );
}
