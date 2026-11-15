// The folder rail: system folders first (the store's order), then the owner's
// folders, with unread counts. Narrow pages get the same choice as a select in
// the header instead.
import { useId, useState } from "react";
import type { Account, Folder, RoleCount, SpecialUse } from "../core/index.ts";
import { ROLE_NAMES, roleFolders } from "../core/actions.ts";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The path the thread list opens on when nothing else is chosen. */
export const DEFAULT_FOLDER_PATH = "INBOX";

/** BB glyph names per special use; the owner's own folders get "Folder". */
const FOLDER_ICONS: Record<SpecialUse, string> = {
  inbox: "Mail",
  sent: "Sent",
  drafts: "EditFile",
  junk: "AlertTriangle",
  trash: "Trash2",
  archive: "Archive",
  all: "Archive",
};

export function folderIcon(specialUse: SpecialUse | null): string {
  return specialUse === null ? "Folder" : FOLDER_ICONS[specialUse];
}

/** The account's inbox path, or null before its folders are known. */
export function inboxPath(folders: readonly Folder[] | null): string | null {
  return folders?.find((f) => f.specialUse === "inbox" && f.selectable)?.path ?? null;
}

/**
 * True when `child` sits below `parent`. The UI's Folder carries no IMAP
 * delimiter, so only the two delimiters servers use in practice count: the
 * parent's exact path followed by "/" (Gmail, iCloud) or "." (Dovecot-style).
 */
function isBelow(child: string, parent: string): boolean {
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}.`);
}

type FolderRow =
  | { kind: "folder"; folder: Folder; depth: number }
  | { kind: "group"; folder: Folder; depth: number };

/**
 * Rows to draw: every selectable folder, and a non-clickable label for a
 * non-selectable folder only when one of the owner's folders sits below it
 * (Gmail's "[Gmail]" holds only system folders, which are listed first). The
 * owner's folders are indented once per drawn ancestor, selectable or not;
 * system folders stay flush.
 */
export function folderRows(folders: readonly Folder[]): FolderRow[] {
  const drawn = folders.filter(
    (folder) =>
      folder.selectable ||
      folders.some((f) => f.selectable && f.specialUse === null && isBelow(f.path, folder.path)),
  );
  const depthOf = (folder: Folder) =>
    folder.specialUse === null ? drawn.filter((d) => isBelow(folder.path, d.path)).length : 0;
  return drawn.map((folder): FolderRow => ({
    kind: folder.selectable ? "folder" : "group",
    folder,
    depth: depthOf(folder),
  }));
}

export interface FolderListProps {
  folders: readonly Folder[];
  selectedPath: string;
  onSelect: (path: string) => void;
}

export interface FolderRailProps extends FolderListProps {
  /** Why the folders could not be loaded; null when they could. */
  error: string | null;
  /** Outbox rows that need the owner, shown on Sent. */
  sentAttention?: number;
}

function RailButton({
  icon,
  name,
  unread,
  selected,
  indent,
  onSelect,
  attention = 0,
}: {
  icon: string;
  name: string;
  unread: number;
  selected: boolean;
  indent: number;
  onSelect: () => void;
  /** Outbox rows that need the owner (Sent only). */
  attention?: number;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
        )}
      >
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate", unread > 0 && "font-medium")}>{name}</span>
        {attention > 0 ? (
          <span className="shrink-0 rounded-sm bg-destructive/10 px-1 text-xs tabular-nums text-destructive">
            {attention}
            <span className="sr-only"> in the Outbox need you</span>
          </span>
        ) : null}
        {unread > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {unread}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

function FolderRowsList({
  folders,
  isSelected,
  onSelect,
  sentAttention = 0,
}: {
  folders: readonly Folder[];
  isSelected: (folder: Folder) => boolean;
  onSelect: (folder: Folder) => void;
  sentAttention?: number;
}) {
  const firstSent = folders.find((f) => f.specialUse === "sent" && f.selectable)?.path ?? null;
  return (
    <>
      {folderRows(folders).map((row) => {
        const { folder, depth } = row;
        if (row.kind === "group") {
          return (
            <li
              key={folder.path}
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
              className="truncate pb-0.5 pr-2 pt-2 text-xs font-medium text-muted-foreground"
            >
              {folder.name}
            </li>
          );
        }
        return (
          <RailButton
            key={folder.path}
            icon={folderIcon(folder.specialUse)}
            name={folder.name}
            unread={folder.unreadCount}
            selected={isSelected(folder)}
            indent={depth}
            onSelect={() => onSelect(folder)}
            attention={folder.path === firstSent ? sentAttention : 0}
          />
        );
      })}
    </>
  );
}

export function FolderList({ folders, selectedPath, onSelect, error, sentAttention }: FolderRailProps) {
  if (folders.length === 0) return <RailHint error={error} />;
  return (
    <ul className="flex flex-col gap-px px-1.5 py-1">
      <FolderRowsList
        folders={folders}
        sentAttention={sentAttention}
        isSelected={(folder) => folder.path === selectedPath}
        onSelect={(folder) => onSelect(folder.path)}
      />
    </ul>
  );
}

function RailHint({ error }: { error: string | null }) {
  return error !== null ? (
    <p role="alert" className="px-3 py-2 text-xs text-destructive">
      Could not load folders: {error}
    </p>
  ) : (
    <p className="px-3 py-2 text-xs text-muted-foreground">Folders appear after the first sync.</p>
  );
}

/** A role merged across every account (never "all": All Mail stays per account). */
export type RoleName = Exclude<SpecialUse, "all">;

/** What the list shows: a merged role (All accounts) or one account's folder. */
export type MailView =
  | { kind: "role"; role: RoleName }
  | { kind: "folder"; accountId: string; path: string };

/** A stable string for a view, for effects and select values. */
export function viewKey(view: MailView): string {
  return view.kind === "role" ? `role:${view.role}` : `folder:${JSON.stringify([view.accountId, view.path])}`;
}

export function sameView(a: MailView, b: MailView): boolean {
  return viewKey(a) === viewKey(b);
}

/**
 * Paths of an account's folders the view covers: the viewed folder, or every
 * folder of the role. Before an account's folders are known, a role Inbox
 * means "INBOX".
 */
export function viewPaths(view: MailView, folders: readonly Folder[], accountId: string): string[] {
  if (view.kind === "folder") return accountId === view.accountId ? [view.path] : [];
  const own = folders.filter((f) => f.accountId === accountId);
  const paths = roleFolders(view.role, own).map((f) => f.path);
  return paths.length === 0 && own.length === 0 && view.role === "inbox" ? [DEFAULT_FOLDER_PATH] : paths;
}

/**
 * An account's folders in All accounts, under its address: everything the
 * merged roles do not cover (its own folders, and Gmail's All Mail).
 */
export function ownFolders(folders: readonly Folder[], accountId: string): Folder[] {
  return folders.filter(
    (f) => f.accountId === accountId && (f.specialUse === null || f.specialUse === "all"),
  );
}

/** The name the owner sees for an account. */
export function accountLabel(account: Pick<Account, "displayName" | "email">): string {
  return account.displayName?.trim() || account.email;
}

export interface UnifiedRailProps {
  roles: readonly RoleCount[];
  folders: readonly Folder[];
  accounts: readonly Account[];
  view: MailView;
  onSelect: (view: MailView) => void;
  error: string | null;
  /** Outbox rows that need the owner, shown on Sent. */
  sentAttention?: number;
}

/** Where the rail remembers which accounts the owner collapsed. */
export const COLLAPSED_ACCOUNTS_KEY = "makosh-mail.collapsedAccounts";

/** The collapsed account ids; empty when nothing (valid) is stored. */
export function readCollapsedAccounts(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_ACCOUNTS_KEY) ?? null;
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** Stores the collapsed account ids; a storage that refuses is ignored. */
export function writeCollapsedAccounts(
  storage: Pick<Storage, "setItem"> | null,
  collapsed: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(COLLAPSED_ACCOUNTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Private mode or a full quota: the state lasts until the page closes.
  }
}

function pageStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AccountGroup({
  account,
  own,
  open,
  onToggle,
  view,
  onSelect,
}: {
  account: Account;
  own: readonly Folder[];
  open: boolean;
  onToggle: () => void;
  view: MailView;
  onSelect: (view: MailView) => void;
}) {
  const listId = useId();
  const label = accountLabel(account);
  const unread = own.reduce((sum, f) => sum + f.unreadCount, 0);
  return (
    <div className="px-1.5 py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className="flex h-6 w-full items-center gap-1 rounded-md px-1 pt-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Chevron open={open} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!open && unread > 0 ? (
          <span className="shrink-0 tabular-nums">
            {unread}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <ul id={listId} aria-label={label} className="flex flex-col gap-px pt-0.5">
          <FolderRowsList
            folders={own}
            isSelected={(folder) =>
              view.kind === "folder" && view.accountId === account.id && view.path === folder.path
            }
            onSelect={(folder) => onSelect({ kind: "folder", accountId: account.id, path: folder.path })}
          />
        </ul>
      ) : null}
    </div>
  );
}

/**
 * All accounts: the merged roles, then each account's own folders under its
 * name, in a group the owner can collapse (remembered on this device). The
 * group holding the open folder stays open.
 */
export function UnifiedRail({ roles, folders, accounts, view, onSelect, error, sentAttention = 0 }: UnifiedRailProps) {
  const shownRoles = roles.filter((r): r is RoleCount & { role: RoleName } => r.role !== "all");
  const [collapsed, setCollapsed] = useState(() => readCollapsedAccounts(pageStorage()));
  const toggle = (accountId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      writeCollapsedAccounts(pageStorage(), next);
      return next;
    });
  };
  return (
    <>
      {error !== null || shownRoles.length === 0 ? <RailHint error={error} /> : null}
      <ul aria-label="All accounts" className="flex flex-col gap-px px-1.5 py-1">
        {shownRoles.map(({ role, unreadCount }) => (
          <RailButton
            key={role}
            icon={folderIcon(role)}
            name={ROLE_NAMES[role]}
            unread={unreadCount}
            selected={view.kind === "role" && view.role === role}
            indent={0}
            onSelect={() => onSelect({ kind: "role", role })}
            attention={role === "sent" ? sentAttention : 0}
          />
        ))}
      </ul>
      {accounts.map((account) => {
        const own = ownFolders(folders, account.id);
        if (own.length === 0) return null;
        const holdsView = view.kind === "folder" && view.accountId === account.id;
        return (
          <AccountGroup
            key={account.id}
            account={account}
            own={own}
            open={holdsView || !collapsed.has(account.id)}
            onToggle={() => toggle(account.id)}
            view={view}
            onSelect={onSelect}
          />
        );
      })}
    </>
  );
}

/** Where focus goes after a value is picked; passed to the select's content. */
export interface SelectFocusProps {
  onCloseAutoFocus?: (event: Event) => void;
}

/** All accounts' rail as a select, for pages too narrow for the rail. */
export function UnifiedSelect({
  roles,
  folders,
  accounts,
  view,
  onSelect,
  onCloseAutoFocus,
}: Omit<UnifiedRailProps, "error"> & SelectFocusProps) {
  const shownRoles = roles.filter((r): r is RoleCount & { role: RoleName } => r.role !== "all");
  const views = new Map<string, MailView>();
  for (const { role } of shownRoles) views.set(viewKey({ kind: "role", role }), { kind: "role", role });
  const groups = accounts.map((account) => ({
    account,
    folders: ownFolders(folders, account.id).filter((f) => f.selectable),
  }));
  for (const { account, folders: own } of groups) {
    for (const f of own) {
      const item: MailView = { kind: "folder", accountId: account.id, path: f.path };
      views.set(viewKey(item), item);
    }
  }
  const label = (count: number, name: string) => (count > 0 ? `${name} (${count})` : name);
  return (
    <Select
      value={viewKey(view)}
      onValueChange={(value) => {
        const next = views.get(value);
        if (next !== undefined) onSelect(next);
      }}
    >
      <SelectTrigger aria-label="Folder" className="h-8 w-auto max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent onCloseAutoFocus={onCloseAutoFocus}>
        {shownRoles.map(({ role, unreadCount }) => (
          <SelectItem key={role} value={viewKey({ kind: "role", role })}>
            {label(unreadCount, ROLE_NAMES[role])}
          </SelectItem>
        ))}
        {groups.map(({ account, folders: own }) =>
          own.length === 0 ? null : (
            <SelectGroup key={account.id}>
              <SelectLabel>{accountLabel(account)}</SelectLabel>
              {own.map((f) => (
                <SelectItem key={f.path} value={viewKey({ kind: "folder", accountId: account.id, path: f.path })}>
                  {label(f.unreadCount, f.name)}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/** The same choice as a select, for pages too narrow for the rail. */
export function FolderSelect({
  folders,
  selectedPath,
  onSelect,
  onCloseAutoFocus,
}: FolderListProps & SelectFocusProps) {
  const selectable = folders.filter((f) => f.selectable);
  if (selectable.length === 0) return null;
  return (
    <Select value={selectedPath} onValueChange={onSelect}>
      <SelectTrigger aria-label="Folder" className="h-8 w-auto max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent onCloseAutoFocus={onCloseAutoFocus}>
        {selectable.map((folder) => (
          <SelectItem key={folder.path} value={folder.path}>
            {folder.unreadCount > 0 ? `${folder.name} (${folder.unreadCount})` : folder.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
