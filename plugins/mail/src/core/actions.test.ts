import { describe, expect, it } from "vitest";
import {
  ROLE_NAMES,
  archiveAllowedFrom,
  flagChangeOf,
  isRoleMoveAction,
  resolveActionDestination,
  resolveMoveDestination,
  roleFolders,
} from "./actions.ts";
import { type Folder, messageActionSchema, type SpecialUse } from "./model.ts";

function folder(path: string, specialUse: SpecialUse | null, overrides: Partial<Folder> = {}): Folder {
  return {
    accountId: "acc_1",
    path,
    name: path.split("/").pop() ?? path,
    specialUse,
    selectable: true,
    unreadCount: 0,
    totalCount: 0,
    subscribed: true,
    ...overrides,
  };
}

const ICLOUD = [
  folder("INBOX", "inbox"),
  folder("Junk", "junk"),
  folder("Archive", "archive"),
  folder("Deleted Messages", "trash", { name: "Trash" }),
  folder("Work", null),
];

const GMAIL = [
  folder("INBOX", "inbox"),
  folder("[Gmail]/Spam", "junk"),
  folder("[Gmail]/All Mail", "all"),
  folder("[Gmail]/Trash", "trash"),
];

describe("resolveActionDestination", () => {
  it("spam goes to the junk folder", () => {
    expect(resolveActionDestination("spam", "INBOX", ICLOUD, "icloud")).toEqual({
      destination: ICLOUD[1],
    });
  });

  it("delete goes to the trash folder from any folder", () => {
    expect(resolveActionDestination("delete", "Work", ICLOUD, "icloud")).toEqual({
      destination: ICLOUD[3],
    });
  });

  it("archive goes to the archive folder outside Gmail", () => {
    expect(resolveActionDestination("archive", "Work", ICLOUD, "icloud")).toEqual({
      destination: ICLOUD[2],
    });
  });

  it("archive on Gmail moves Inbox copies to All Mail", () => {
    expect(resolveActionDestination("archive", "INBOX", GMAIL, "gmail")).toEqual({
      destination: GMAIL[2],
    });
  });

  it("archive is Gmail-style without the gmail preset when there is All Mail and no Archive", () => {
    expect(resolveActionDestination("archive", "INBOX", GMAIL, "other")).toEqual({
      destination: GMAIL[2],
    });
  });

  it("archive on Gmail outside the Inbox is refused", () => {
    expect(resolveActionDestination("archive", "[Gmail]/Spam", GMAIL, "gmail")).toEqual({
      refusal: "Already archived",
    });
  });

  it("not spam goes to the inbox from Spam only", () => {
    expect(resolveActionDestination("not_spam", "Junk", ICLOUD, "icloud")).toEqual({
      destination: ICLOUD[0],
    });
    expect(resolveActionDestination("not_spam", "INBOX", ICLOUD, "icloud")).toEqual({
      refusal: "Not spam works only in Spam",
    });
  });

  it("refuses when the account has no folder for the action", () => {
    const bare = [folder("INBOX", "inbox")];
    expect(resolveActionDestination("spam", "INBOX", bare, "other")).toEqual({
      refusal: "This account has no Spam folder",
    });
    expect(resolveActionDestination("archive", "INBOX", bare, "other")).toEqual({
      refusal: "This account has no Archive folder",
    });
    expect(resolveActionDestination("delete", "INBOX", bare, "other")).toEqual({
      refusal: "This account has no Trash folder",
    });
    expect(resolveActionDestination("archive", "INBOX", [folder("INBOX", "inbox")], "gmail")).toEqual({
      refusal: "This account has no Archive folder",
    });
  });

  it("refuses a destination that cannot hold messages", () => {
    const folders = [folder("INBOX", "inbox"), folder("Trash", "trash", { selectable: false })];
    expect(resolveActionDestination("delete", "INBOX", folders, "other")).toEqual({
      refusal: "Trash cannot hold messages",
    });
  });

  it("refuses a move into the folder the messages are already in", () => {
    expect(resolveActionDestination("spam", "Junk", ICLOUD, "icloud")).toEqual({
      refusal: "Already in Junk",
    });
    expect(resolveActionDestination("delete", "Deleted Messages", ICLOUD, "icloud")).toEqual({
      refusal: "Already in Trash",
    });
  });

  it("refuses a move between two folders with the same role", () => {
    const folders = [
      folder("INBOX", "inbox"),
      folder("Junk", "junk"),
      folder("Bulk Mail", "junk", { name: "Bulk" }),
      folder("Trash", "trash"),
      folder("Old Trash", "trash"),
    ];
    expect(resolveActionDestination("spam", "Bulk Mail", folders, "other")).toEqual({
      refusal: "Already in Bulk",
    });
    expect(resolveActionDestination("delete", "Old Trash", folders, "other")).toEqual({
      refusal: "Already in Old Trash",
    });
    expect(resolveActionDestination("not_spam", "Bulk Mail", folders, "other")).toEqual({
      destination: folders[0],
    });
  });

  it("refuses an unknown source folder", () => {
    expect(resolveActionDestination("delete", "Gone", ICLOUD, "icloud")).toEqual({
      refusal: "Unknown folder",
    });
  });
});

describe("archiveAllowedFrom", () => {
  it("on Gmail-style accounts allows Archive only in the Inbox", () => {
    for (const preset of ["gmail", "other"] as const) {
      expect(archiveAllowedFrom("inbox", GMAIL, preset)).toBe(true);
      for (const use of ["junk", "all", "trash", "sent", null] as const) {
        expect(archiveAllowedFrom(use, GMAIL, preset), `${preset} ${use}`).toBe(false);
      }
    }
  });

  it("elsewhere allows Archive except in Archive, All Mail and Trash", () => {
    for (const use of ["inbox", "junk", "sent", "drafts", null] as const) {
      expect(archiveAllowedFrom(use, ICLOUD, "icloud"), String(use)).toBe(true);
    }
    for (const use of ["archive", "all", "trash"] as const) {
      expect(archiveAllowedFrom(use, ICLOUD, "icloud"), use).toBe(false);
    }
  });

  it("is the rule resolveActionDestination applies", () => {
    const both = [...ICLOUD, folder("All", "all")];
    expect(resolveActionDestination("archive", "Deleted Messages", ICLOUD, "icloud")).toEqual({
      refusal: "Archive does not work in Trash",
    });
    expect(resolveActionDestination("archive", "All", both, "icloud")).toEqual({
      refusal: "Already archived",
    });
    expect(resolveActionDestination("archive", "Archive", ICLOUD, "icloud")).toEqual({
      refusal: "Already in Archive",
    });
    for (const [folders, preset] of [[ICLOUD, "icloud"], [GMAIL, "gmail"], [both, "icloud"]] as const) {
      for (const source of folders) {
        const allowed = archiveAllowedFrom(source.specialUse, folders, preset);
        const result = resolveActionDestination("archive", source.path, folders, preset);
        expect("destination" in result, `${preset} ${source.path}`).toBe(allowed);
      }
    }
  });
});

describe("isRoleMoveAction", () => {
  it("is true for the moves by role only", () => {
    expect(messageActionSchema.options.filter((action) => isRoleMoveAction(action))).toEqual([
      "spam",
      "not_spam",
      "archive",
      "delete",
    ]);
  });
});

describe("flagChangeOf", () => {
  it("maps the flag actions to a FlagChange and moves to null", () => {
    expect(messageActionSchema.options.map((action) => [action, flagChangeOf(action)])).toEqual([
      ["spam", null],
      ["not_spam", null],
      ["archive", null],
      ["delete", null],
      ["mark_read", { seen: true }],
      ["mark_unread", { seen: false }],
      ["flag", { flagged: true }],
      ["unflag", { flagged: false }],
      ["move", null],
    ]);
  });
});

describe("resolveMoveDestination", () => {
  it("moves to another selectable folder of the account", () => {
    expect(resolveMoveDestination("Work", "INBOX", ICLOUD)).toEqual({ destination: ICLOUD[4] });
  });

  it("refuses an unknown folder, a folder that cannot hold mail and the source", () => {
    expect(resolveMoveDestination("Nowhere", "INBOX", ICLOUD)).toEqual({
      refusal: "This account has no folder Nowhere",
    });
    const folders = [...ICLOUD, folder("Projects", null, { selectable: false })];
    expect(resolveMoveDestination("Projects", "INBOX", folders)).toEqual({
      refusal: "Projects cannot hold messages",
    });
    expect(resolveMoveDestination("Work", "Work", ICLOUD)).toEqual({ refusal: "Already in Work" });
  });

  it("refuses an unknown source folder", () => {
    expect(resolveMoveDestination("Work", "Gone", ICLOUD)).toEqual({ refusal: "Unknown folder" });
  });
});

describe("roleFolders", () => {
  it("returns the folders of the role; archive never includes All Mail", () => {
    expect(roleFolders("trash", ICLOUD).map((f) => f.path)).toEqual(["Deleted Messages"]);
    expect(roleFolders("archive", GMAIL)).toEqual([]);
    expect(roleFolders("archive", ICLOUD).map((f) => f.path)).toEqual(["Archive"]);
  });

  it("names every role but all", () => {
    expect(ROLE_NAMES).toEqual({
      inbox: "Inbox",
      sent: "Sent",
      drafts: "Drafts",
      junk: "Spam",
      archive: "Archive",
      trash: "Trash",
    });
  });
});
