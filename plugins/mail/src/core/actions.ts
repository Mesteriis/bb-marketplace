// Where an owner-clicked message action moves mail, from the account's
// folders by special use. Pure: the server queues the move it returns.
import type { AccountPreset, Folder, MessageAction, SpecialUse } from "./model.ts";

export type ActionDestination = { destination: Folder } | { refusal: string };

/** Names used in refusals for a missing special-use folder. */
const MISSING_NAME: Record<"junk" | "archive" | "trash" | "inbox", string> = {
  junk: "Spam",
  archive: "Archive",
  trash: "Trash",
  inbox: "Inbox",
};

/**
 * The destination for moving messages out of `sourcePath`:
 * spam → junk; not spam → inbox (only from junk); archive → All Mail from the
 * Inbox on Gmail-style accounts (the gmail preset, or an All Mail folder and
 * no Archive folder), else the archive folder; delete → trash. Refuses when
 * the folder is missing, cannot hold messages, or is the source itself.
 */
export function resolveActionDestination(
  action: MessageAction,
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
      const gmailStyle =
        preset === "gmail" || (byUse("all") !== undefined && byUse("archive") === undefined);
      if (gmailStyle && source.specialUse !== "inbox") return { refusal: "Already archived" };
      use = gmailStyle ? "all" : "archive";
      missing = MISSING_NAME.archive;
      break;
    }
    case "delete":
      use = "trash";
      missing = MISSING_NAME.trash;
      break;
  }
  const destination = byUse(use);
  if (destination === undefined) return { refusal: `This account has no ${missing} folder` };
  if (!destination.selectable) return { refusal: `${destination.name} cannot hold messages` };
  if (destination.path === source.path) return { refusal: `Already in ${destination.name}` };
  return { destination };
}
