// Folder management rules (slice 3h, #49): which names a new or renamed
// folder may take and which folders may be renamed or deleted, checked
// before any command reaches the server. Pure: whether imapflow would read
// a name as special use (spec resolution 18) is asked through the injected
// `namedLikeSpecialUse`, so the core stays imapflow-free.
import type { SpecialUse } from "./model.ts";

export const FOLDER_NAME_MAX = 100;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type FolderNameRefusal = "empty" | "too_long" | "control" | "delimiter" | "reserved" | "exists" | "special_use";

export type FolderNameOptions = {
  /** The account's hierarchy delimiter; "" when the server has none. */
  delimiter: string;
  /** Names of the folders under the same parent (compared case-insensitively). */
  siblings: readonly string[];
  namedLikeSpecialUse: (name: string) => boolean;
};

/** A new or renamed folder's name: 1-100 characters after trim, none of the refusals. */
export function validFolderName(
  raw: string,
  options: FolderNameOptions,
): { ok: true; name: string } | { ok: false; reason: FolderNameRefusal } {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "empty" };
  if (name.length > FOLDER_NAME_MAX) return { ok: false, reason: "too_long" };
  if (CONTROL.test(name)) return { ok: false, reason: "control" };
  if (options.delimiter !== "" && name.includes(options.delimiter)) return { ok: false, reason: "delimiter" };
  if (name === "." || name === ".." || name.toUpperCase() === "INBOX") return { ok: false, reason: "reserved" };
  const lower = name.toLowerCase();
  if (options.siblings.some((sibling) => sibling.toLowerCase() === lower)) return { ok: false, reason: "exists" };
  if (options.namedLikeSpecialUse(name)) return { ok: false, reason: "special_use" };
  return { ok: true, name };
}

/** What a folder rule needs to know about a folder. */
export type FolderRef = { path: string; specialUse: SpecialUse | null; selectable: boolean };

export type FolderOp = "rename" | "delete";

export type FolderOpRefusal =
  | "inbox"
  | "special_use"
  | "gmail_system"
  | "snooze_folder"
  | "has_children"
  | "move_pending"
  | "parent_not_selectable";

export type FolderOpContext = {
  op: FolderOp;
  /** Folders under this one (stored list, rechecked by a fresh LIST before a delete). */
  children: number;
  /** The account's snooze folder path, or null. */
  snoozeFolder: string | null;
  gmail: boolean;
  /** Rows waiting to move out of or into this folder. */
  movePending: number;
  /** Rename: whether the parent folder can be selected (default true). */
  parentSelectable?: boolean;
};

/** A path under Gmail's [Gmail] / [Google Mail] (or that folder itself). */
export function underGmailSystem(path: string): boolean {
  const lower = path.toLowerCase();
  return ["[gmail]", "[google mail]"].some((root) => lower === root || lower.startsWith(`${root}/`) || lower.startsWith(`${root}.`));
}

/** Why the owner may not rename or delete this folder, or null. */
export function folderOpRefusal(folder: FolderRef, context: FolderOpContext): FolderOpRefusal | null {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  if (folder.specialUse !== null) return "special_use";
  if (underGmailSystem(folder.path)) return "gmail_system";
  if (context.snoozeFolder !== null && folder.path === context.snoozeFolder) return "snooze_folder";
  if (context.op === "delete" && context.children > 0) return "has_children";
  if (context.movePending > 0) return "move_pending";
  if (context.op === "rename" && context.parentSelectable === false) return "parent_not_selectable";
  return null;
}

/**
 * A Gmail label folder (spec resolution 5): deleted by a plain DELETE,
 * which removes only the label.
 */
export function gmailLabelFolder(folder: FolderRef, gmail: boolean): boolean {
  return gmail && folder.path.toUpperCase() !== "INBOX" && folder.specialUse === null && !underGmailSystem(folder.path);
}

/**
 * The path after renaming `from` to `to`: the path itself or a child
 * (`from` + delimiter + rest); null when the rename does not touch it.
 */
export function renamedPath(path: string, from: string, to: string, delimiter: string): string | null {
  if (path === from) return to;
  if (delimiter !== "" && path.startsWith(from + delimiter)) return to + path.slice(from.length);
  return null;
}
