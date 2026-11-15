// Where an owner-clicked message action moves mail, from the account's
// folders by special use. Pure: the server queues the move it returns.
import type {
  AccountPreset,
  FlagChange,
  Folder,
  MessageAction,
  RoleMoveAction,
  SpecialUse,
} from "./model.ts";

/** Whether the action moves mail to a folder chosen by its role. */
export function isRoleMoveAction(action: MessageAction): action is RoleMoveAction {
  return action === "spam" || action === "not_spam" || action === "archive" || action === "delete";
}

/** The \Seen / \Flagged change of a flag action, or null for a move. */
export function flagChangeOf(action: MessageAction): FlagChange | null {
  switch (action) {
    case "mark_read":
      return { seen: true };
    case "mark_unread":
      return { seen: false };
    case "flag":
      return { flagged: true };
    case "unflag":
      return { flagged: false };
    default:
      return null;
  }
}

/** The roles merged in All accounts, with the names the owner sees. */
export const ROLE_NAMES: Record<Exclude<SpecialUse, "all">, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  junk: "Spam",
  archive: "Archive",
  trash: "Trash",
};

/**
 * An account's folders of a role, by their effective special use; Archive
 * means `archive` folders only, never Gmail All Mail (that is role "all").
 */
export function roleFolders(role: SpecialUse, folders: Folder[]): Folder[] {
  return folders.filter((f) => f.specialUse === role);
}

export type ActionDestination = { destination: Folder } | { refusal: string };

/** Names used in refusals for a missing special-use folder. */
const MISSING_NAME: Record<"junk" | "archive" | "trash" | "inbox", string> = {
  junk: "Spam",
  archive: "Archive",
  trash: "Trash",
  inbox: "Inbox",
};

/** Gmail-style: the gmail preset, or an All Mail folder and no Archive folder. */
function isGmailStyle(folders: Folder[], preset: AccountPreset): boolean {
  const has = (use: SpecialUse) => folders.some((f) => f.specialUse === use);
  return preset === "gmail" || (has("all") && !has("archive"));
}

/**
 * Whether Archive applies to messages in a folder of this special use:
 * on Gmail-style accounts only in the Inbox, elsewhere anywhere but Archive,
 * All Mail and Trash. The server refuses exactly where this is false; the UI
 * hides the button there.
 */
export function archiveAllowedFrom(
  sourceUse: SpecialUse | null,
  folders: Folder[],
  preset: AccountPreset,
): boolean {
  if (isGmailStyle(folders, preset)) return sourceUse === "inbox";
  return sourceUse !== "archive" && sourceUse !== "all" && sourceUse !== "trash";
}

/**
 * The destination for moving messages out of `sourcePath`:
 * spam → junk; not spam → inbox (only from junk); archive → All Mail from the
 * Inbox on Gmail-style accounts, else the archive folder (where
 * archiveAllowedFrom allows it); delete → trash. Refuses when
 * the folder is missing, cannot hold messages, or is the source itself.
 */
export function resolveActionDestination(
  action: RoleMoveAction,
  sourcePath: string,
  folders: Folder[],
  preset: AccountPreset,
): ActionDestination {
  const source = folders.find((f) => f.path === sourcePath);
  if (source === undefined) return { refusal: "Unknown folder" };
  const byUse = (use: SpecialUse) => folders.find((f) => f.specialUse === use);

  let use: SpecialUse;
  let missing: string;
  switch (action) {
    case "spam":
      use = "junk";
      missing = MISSING_NAME.junk;
      break;
    case "not_spam":
      if (source.specialUse !== "junk") return { refusal: "Not spam works only in Spam" };
      use = "inbox";
      missing = MISSING_NAME.inbox;
      break;
    case "archive": {
      const gmailStyle = isGmailStyle(folders, preset);
      if (!archiveAllowedFrom(source.specialUse, folders, preset)) {
        if (source.specialUse === "trash") return { refusal: "Archive does not work in Trash" };
        // Archive itself keeps the same-role refusal below ("Already in Archive").
        if (gmailStyle || source.specialUse !== "archive") return { refusal: "Already archived" };
      }
      use = gmailStyle ? "all" : "archive";
      missing = MISSING_NAME.archive;
      break;
    }
    case "delete":
      use = "trash";
      missing = MISSING_NAME.trash;
      break;
  }
  // Another folder with the same role (two Junk folders) is no move at all.
  if (source.specialUse === use) return { refusal: `Already in ${source.name}` };
  const destination = byUse(use);
  if (destination === undefined) return { refusal: `This account has no ${missing} folder` };
  if (!destination.selectable) return { refusal: `${destination.name} cannot hold messages` };
  if (destination.path === source.path) return { refusal: `Already in ${destination.name}` };
  return { destination };
}

/**
 * The destination of "Move to…": a folder of the same account (`folders`)
 * that can hold messages and is not the source.
 */
export function resolveMoveDestination(
  destinationPath: string,
  sourcePath: string,
  folders: Folder[],
): ActionDestination {
  if (!folders.some((f) => f.path === sourcePath)) return { refusal: "Unknown folder" };
  const destination = folders.find((f) => f.path === destinationPath);
  if (destination === undefined) return { refusal: `This account has no folder ${destinationPath}` };
  if (!destination.selectable) return { refusal: `${destination.name} cannot hold messages` };
  if (destination.path === sourcePath) return { refusal: `Already in ${destination.name}` };
  return { destination };
}
