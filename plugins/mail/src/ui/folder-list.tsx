// The folder rail: system folders first (the store's order), then the owner's
// folders, with unread counts. Narrow pages get the same choice as a select in
// the header instead.
import type { Folder, SpecialUse } from "../core/index.ts";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
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

/** True when `child` sits below `parent` in the folder tree (any one-character delimiter). */
function isBelow(child: string, parent: string): boolean {
  if (child.length <= parent.length + 1 || !child.startsWith(parent)) return false;
  return !/[\p{L}\p{N}]/u.test(child[parent.length]!);
}

type FolderRow =
  | { kind: "folder"; folder: Folder; depth: number }
  | { kind: "group"; folder: Folder; depth: number };

/**
 * Rows to draw: every selectable folder, and a non-clickable label for a
 * non-selectable folder only when one of the owner's folders sits below it
 * (Gmail's "[Gmail]" holds only system folders, which are listed first).
 */
export function folderRows(folders: readonly Folder[]): FolderRow[] {
  const groups = folders.filter(
    (group) =>
      !group.selectable &&
      folders.some((f) => f.selectable && f.specialUse === null && isBelow(f.path, group.path)),
  );
  const depthOf = (folder: Folder) =>
    folder.specialUse === null ? groups.filter((g) => isBelow(folder.path, g.path)).length : 0;
  const rows: FolderRow[] = [];
  for (const folder of folders) {
    if (folder.selectable) rows.push({ kind: "folder", folder, depth: depthOf(folder) });
    else if (groups.includes(folder)) rows.push({ kind: "group", folder, depth: depthOf(folder) });
  }
  return rows;
}

export interface FolderListProps {
  folders: readonly Folder[];
  selectedPath: string;
  onSelect: (path: string) => void;
}

export function FolderList({ folders, selectedPath, onSelect }: FolderListProps) {
  if (folders.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">Folders appear after the first sync.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-px px-1.5 py-1">
      {folderRows(folders).map((row) => {
        const { folder, depth } = row;
        const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };
        if (row.kind === "group") {
          return (
            <li
              key={folder.path}
              style={indent}
              className="truncate pb-0.5 pr-2 pt-2 text-xs font-medium text-muted-foreground"
            >
              {folder.name}
            </li>
          );
        }
        const selected = folder.path === selectedPath;
        return (
          <li key={folder.path}>
            <button
              type="button"
              onClick={() => onSelect(folder.path)}
              aria-current={selected ? "page" : undefined}
              style={indent}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-state-active hover:bg-state-active",
              )}
            >
              <Icon
                name={folderIcon(folder.specialUse)}
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className={cn("min-w-0 flex-1 truncate", folder.unreadCount > 0 && "font-medium")}>
                {folder.name}
              </span>
              {folder.unreadCount > 0 ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {folder.unreadCount}
                  <span className="sr-only"> unread</span>
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The same choice as a select, for pages too narrow for the rail. */
export function FolderSelect({ folders, selectedPath, onSelect }: FolderListProps) {
  const selectable = folders.filter((f) => f.selectable);
  if (selectable.length === 0) return null;
  return (
    <Select value={selectedPath} onValueChange={onSelect}>
      <SelectTrigger aria-label="Folder" className="h-8 w-auto max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {selectable.map((folder) => (
          <SelectItem key={folder.path} value={folder.path}>
            {folder.unreadCount > 0 ? `${folder.name} (${folder.unreadCount})` : folder.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
