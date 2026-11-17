// The folder rail, drawn in BB's sidebar on the Mail page: system folders
// first (the store's order), then the owner's folders, with unread counts.
// Slice 3h: each folder has a menu, unsubscribed folders sit under More
// folders, and folders take dropped conversations (drag-move.ts).
import { useId, useState, type DragEvent } from "react";
import type { Account, Folder, RoleCount, SpecialUse } from "../core/index.ts";
import { ROLE_NAMES, roleFolders } from "../core/actions.ts";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { carriesMove, MOVE_TYPE } from "./drag-move.ts";
import { tx } from "./i18n/index.ts";

/** The account chooser's value for All accounts. */
export const ALL_ACCOUNTS = "__all_accounts__";

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
  /** Slice 3h: folder menus and drop targets; absent: neither. */
  extras?: RailExtras;
}

/** Slice 3h: what the rail's folders offer beyond opening. */
export interface RailExtras {
  /** The folder's menu (new subfolder, rename, subscribed, delete, ...). */
  onMenu?: (folder: Folder) => void;
  /** Drops of conversations dragged from this page's list. */
  drop?: {
    /** Whether the folder takes the drag in progress (its account's folders only). */
    accepts: (folder: Folder) => boolean;
    /** The raw payload of the private type; the page checks it. */
    onDrop: (folder: Folder, raw: string) => void;
    /** All accounts: a drop on merged Trash, Spam or Archive runs that role's action. */
    onRoleDrop?: (role: RoleName, raw: string) => void;
  };
}

/** The merged roles a drop goes to: their action is the same for every account. */
const DROP_ROLES: ReadonlySet<string> = new Set(["trash", "junk", "archive"]);

/** The owner's folders that are not subscribed: listed under More folders. */
export function unsubscribedFolders(folders: readonly Folder[]): Folder[] {
  return folders.filter((f) => !f.subscribed && f.specialUse === null && f.selectable);
}

function RailButton({
  icon,
  name,
  unread,
  selected,
  indent,
  onSelect,
  attention = 0,
  dimmed = false,
  onMenu,
  drop,
}: {
  icon: string;
  name: string;
  unread: number;
  selected: boolean;
  indent: number;
  onSelect: () => void;
  /** Outbox rows that need the owner (Sent only). */
  attention?: number;
  /** Slice 3h: an unsubscribed folder under More folders. */
  dimmed?: boolean;
  onMenu?: () => void;
  drop?: { accepts: () => boolean; onDrop: (raw: string) => void };
}) {
  const [over, setOver] = useState<"yes" | "no" | null>(null);
  const dragOver = (event: DragEvent<HTMLLIElement>) => {
    if (drop === undefined || !carriesMove(event.dataTransfer?.types)) return;
    if (drop.accepts()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setOver("yes");
    } else {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      setOver("no");
    }
  };
  return (
    <li
      className="group relative flex items-center"
      {...(drop !== undefined
        ? {
            onDragOver: dragOver,
            onDragEnter: dragOver,
            onDragLeave: () => setOver(null),
            onDrop: (event: DragEvent<HTMLLIElement>) => {
              setOver(null);
              if (!carriesMove(event.dataTransfer?.types) || !drop.accepts()) return;
              event.preventDefault();
              drop.onDrop(event.dataTransfer.getData(MOVE_TYPE));
            },
          }
        : {})}
      title={over === "no" ? tx("Not allowed: another account") : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
          dimmed && "text-muted-foreground",
          over === "yes" && "bg-state-active ring-1 ring-inset ring-ring",
          over === "no" && "cursor-not-allowed opacity-60",
        )}
      >
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate", unread > 0 && "font-medium")}>{name}</span>
        {attention > 0 ? (
          <span className="shrink-0 rounded-sm bg-destructive/10 px-1 text-xs tabular-nums text-destructive">
            {attention}
            <span className="sr-only"> {tx("in the Outbox need you")}</span>
          </span>
        ) : null}
        {unread > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {unread}
            <span className="sr-only"> {tx("unread")}</span>
          </span>
        ) : null}
      </button>
      {onMenu !== undefined ? (
        <button
          type="button"
          aria-label={tx("Folder options")}
          title={`${name} options`}
          onClick={onMenu}
          className="absolute right-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon name="MoreHorizontal" fallback="Info" className="size-4" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function FolderRowsList({
  folders,
  isSelected,
  onSelect,
  sentAttention = 0,
  extras,
}: {
  folders: readonly Folder[];
  isSelected: (folder: Folder) => boolean;
  onSelect: (folder: Folder) => void;
  sentAttention?: number;
  extras?: RailExtras;
}) {
  const firstSent = folders.find((f) => f.specialUse === "sent" && f.selectable)?.path ?? null;
  const hidden = new Set(extras !== undefined ? unsubscribedFolders(folders) : []);
  const shown = folders.filter((f) => !hidden.has(f));
  const [more, setMore] = useState(false);
  const button = (folder: Folder, depth: number, dimmed: boolean) => (
    <RailButton
      key={folder.path}
      icon={folderIcon(folder.specialUse)}
      name={folder.name}
      unread={folder.unreadCount}
      selected={isSelected(folder)}
      indent={depth}
      onSelect={() => onSelect(folder)}
      attention={folder.path === firstSent ? sentAttention : 0}
      dimmed={dimmed}
      {...(extras?.onMenu !== undefined ? { onMenu: () => extras.onMenu!(folder) } : {})}
      {...(extras?.drop !== undefined
        ? { drop: { accepts: () => extras.drop!.accepts(folder), onDrop: (raw: string) => extras.drop!.onDrop(folder, raw) } }
        : {})}
    />
  );
  return (
    <>
      {folderRows(shown).map((row) => {
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
        return button(folder, depth, false);
      })}
      {hidden.size > 0 ? (
        <>
          <li>
            <button
              type="button"
              aria-expanded={more || [...hidden].some(isSelected)}
              onClick={() => setMore((open) => !open)}
              className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Chevron open={more || [...hidden].some(isSelected)} />
              {`More folders (${hidden.size})`}
            </button>
          </li>
          {more || [...hidden].some(isSelected) ? [...hidden].map((folder) => button(folder, 1, true)) : null}
        </>
      ) : null}
    </>
  );
}

export function FolderList({ folders, selectedPath, onSelect, error, sentAttention, extras }: FolderRailProps) {
  if (folders.length === 0) return <RailHint error={error} />;
  return (
    <ul className="flex flex-col gap-px px-1.5 py-1">
      <FolderRowsList
        folders={folders}
        sentAttention={sentAttention}
        {...(extras !== undefined ? { extras } : {})}
        isSelected={(folder) => folder.path === selectedPath}
        onSelect={(folder) => onSelect(folder.path)}
      />
    </ul>
  );
}

function RailHint({ error }: { error: string | null }) {
  return error !== null ? (
    <p role="alert" className="px-3 py-2 text-xs text-destructive">
      {tx("Could not load folders:")} {error}
    </p>
  ) : (
    <p className="px-3 py-2 text-xs text-muted-foreground">{tx("Folders appear after the first sync.")}</p>
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
  /** Slice 3h: folder menus and drop targets of the accounts' own folders. */
  extras?: RailExtras;
  /** Slice 3h: an account's menu (New folder...). */
  onAccountMenu?: (account: Account) => void;
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
  extras,
  onMenu,
}: {
  account: Account;
  own: readonly Folder[];
  open: boolean;
  onToggle: () => void;
  view: MailView;
  onSelect: (view: MailView) => void;
  extras?: RailExtras;
  onMenu?: () => void;
}) {
  const listId = useId();
  const label = accountLabel(account);
  const unread = own.reduce((sum, f) => sum + f.unreadCount, 0);
  return (
    <div className="px-1.5 py-1">
      <div className="group flex items-center">
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
            <span className="sr-only"> {tx("unread")}</span>
          </span>
        ) : null}
      </button>
      {onMenu !== undefined ? (
        <button
          type="button"
          aria-label={tx("Account options")}
          title={`${label} options`}
          onClick={onMenu}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon name="MoreHorizontal" fallback="Info" className="size-4" aria-hidden />
        </button>
      ) : null}
      </div>
      {open ? (
        <ul id={listId} aria-label={label} className="flex flex-col gap-px pt-0.5">
          <FolderRowsList
            folders={own}
            isSelected={(folder) =>
              view.kind === "folder" && view.accountId === account.id && view.path === folder.path
            }
            onSelect={(folder) => onSelect({ kind: "folder", accountId: account.id, path: folder.path })}
            {...(extras !== undefined ? { extras } : {})}
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
export function UnifiedRail({ roles, folders, accounts, view, onSelect, error, sentAttention = 0, extras, onAccountMenu }: UnifiedRailProps) {
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
      <ul aria-label={tx("All accounts")} className="flex flex-col gap-px px-1.5 py-1">
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
            {...(extras?.drop?.onRoleDrop !== undefined && DROP_ROLES.has(role)
              ? { drop: { accepts: () => true, onDrop: (raw: string) => extras.drop!.onRoleDrop!(role, raw) } }
              : {})}
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
            {...(extras !== undefined ? { extras } : {})}
            {...(onAccountMenu !== undefined ? { onMenu: () => onAccountMenu(account) } : {})}
          />
        );
      })}
    </>
  );
}
