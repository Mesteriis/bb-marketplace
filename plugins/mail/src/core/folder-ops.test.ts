import { describe, expect, it, vi } from "vitest";
import type { SpecialUse } from "./model.ts";
import {
  FOLDER_NAME_MAX,
  folderOpRefusal,
  gmailLabelFolder,
  renamedPath,
  validFolderName,
  type FolderRef,
} from "./folder-ops.ts";

const none = () => false;
const opts = (extra: Partial<Parameters<typeof validFolderName>[1]> = {}) => ({
  delimiter: "/",
  siblings: ["Work", "Receipts"],
  namedLikeSpecialUse: none,
  ...extra,
});

describe("validFolderName", () => {
  it("accepts a name, trimmed", () => {
    expect(validFolderName("  Plans  ", opts())).toEqual({ ok: true, name: "Plans" });
  });

  it("refuses each rule", () => {
    expect(validFolderName("  ", opts())).toEqual({ ok: false, reason: "empty" });
    expect(validFolderName("a".repeat(FOLDER_NAME_MAX + 1), opts())).toEqual({ ok: false, reason: "too_long" });
    expect(validFolderName("a\u0000b", opts())).toEqual({ ok: false, reason: "control" });
    expect(validFolderName("a/b", opts())).toEqual({ ok: false, reason: "delimiter" });
    expect(validFolderName("a.b", opts({ delimiter: "." }))).toEqual({ ok: false, reason: "delimiter" });
    expect(validFolderName(".", opts())).toEqual({ ok: false, reason: "reserved" });
    expect(validFolderName("..", opts())).toEqual({ ok: false, reason: "reserved" });
    expect(validFolderName("InBoX", opts())).toEqual({ ok: false, reason: "reserved" });
    expect(validFolderName("work", opts())).toEqual({ ok: false, reason: "exists" });
  });

  it("allows the delimiter when the account has none", () => {
    expect(validFolderName("a/b", opts({ delimiter: "" }))).toEqual({ ok: true, name: "a/b" });
  });

  it("asks the injected special-use check", () => {
    const named = vi.fn((name: string) => name === "Sent Items");
    expect(validFolderName("Sent Items", opts({ namedLikeSpecialUse: named }))).toEqual({ ok: false, reason: "special_use" });
    expect(named).toHaveBeenCalledWith("Sent Items");
    expect(validFolderName("Plans", opts({ namedLikeSpecialUse: named }))).toEqual({ ok: true, name: "Plans" });
  });
});

const folder = (path: string, specialUse: SpecialUse | null = null, selectable = true): FolderRef => ({
  path,
  specialUse,
  selectable,
});
const base = { children: 0, snoozeFolder: "Snoozed", gmail: false, movePending: 0 };

describe("folderOpRefusal", () => {
  it("allows an ordinary folder", () => {
    expect(folderOpRefusal(folder("Work"), { op: "delete", ...base })).toBeNull();
    expect(folderOpRefusal(folder("INBOX/Sub"), { op: "rename", ...base })).toBeNull();
  });

  it("refuses INBOX, special use, [Gmail] paths and the snooze folder", () => {
    expect(folderOpRefusal(folder("inbox"), { op: "rename", ...base })).toBe("inbox");
    expect(folderOpRefusal(folder("Sent", "sent"), { op: "delete", ...base })).toBe("special_use");
    expect(folderOpRefusal(folder("[Gmail]/Important"), { op: "delete", ...base })).toBe("gmail_system");
    expect(folderOpRefusal(folder("[Google Mail]"), { op: "rename", ...base })).toBe("gmail_system");
    expect(folderOpRefusal(folder("Snoozed"), { op: "delete", ...base })).toBe("snooze_folder");
  });

  it("refuses a delete with children, but not a rename", () => {
    expect(folderOpRefusal(folder("Work"), { op: "delete", ...base, children: 2 })).toBe("has_children");
    expect(folderOpRefusal(folder("Work"), { op: "rename", ...base, children: 2 })).toBeNull();
  });

  it("refuses pending moves", () => {
    expect(folderOpRefusal(folder("Work"), { op: "delete", ...base, movePending: 1 })).toBe("move_pending");
  });

  it("refuses a rename under a parent that cannot be selected", () => {
    expect(folderOpRefusal(folder("Group/Work"), { op: "rename", ...base, parentSelectable: false })).toBe("parent_not_selectable");
    expect(folderOpRefusal(folder("Group/Work"), { op: "delete", ...base, parentSelectable: false })).toBeNull();
  });
});

describe("gmailLabelFolder", () => {
  it("is a Gmail folder that is not INBOX, special use or under [Gmail]", () => {
    expect(gmailLabelFolder(folder("Receipts"), true)).toBe(true);
    expect(gmailLabelFolder(folder("Receipts"), false)).toBe(false);
    expect(gmailLabelFolder(folder("INBOX"), true)).toBe(false);
    expect(gmailLabelFolder(folder("[Gmail]/Trash", "trash"), true)).toBe(false);
    expect(gmailLabelFolder(folder("[Gmail]/Important"), true)).toBe(false);
  });
});

describe("renamedPath", () => {
  it("renames the path and its children, not a sibling prefix", () => {
    expect(renamedPath("Work", "Work", "Jobs", "/")).toBe("Jobs");
    expect(renamedPath("Work/2026/Q1", "Work", "Jobs", "/")).toBe("Jobs/2026/Q1");
    expect(renamedPath("Work2", "Work", "Jobs", "/")).toBeNull();
    expect(renamedPath("Workshop/x", "Work", "Jobs", "/")).toBeNull();
    expect(renamedPath("Home", "Work", "Jobs", "/")).toBeNull();
  });

  it("renames only the path itself without a delimiter", () => {
    expect(renamedPath("Work", "Work", "Jobs", "")).toBe("Jobs");
    expect(renamedPath("Work/x", "Work", "Jobs", "")).toBeNull();
  });
});
