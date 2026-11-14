import { describe, expect, it } from "vitest";
import { resolveActionDestination } from "./actions.ts";
import type { Folder, SpecialUse } from "./model.ts";

function folder(path: string, specialUse: SpecialUse | null, overrides: Partial<Folder> = {}): Folder {
  return {
    accountId: "acc_1",
    path,
    name: path.split("/").pop() ?? path,
    specialUse,
    selectable: true,
    unreadCount: 0,
    totalCount: 0,
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

  it("refuses an unknown source folder", () => {
    expect(resolveActionDestination("delete", "Gone", ICLOUD, "icloud")).toEqual({
      refusal: "Unknown folder",
    });
  });
});
