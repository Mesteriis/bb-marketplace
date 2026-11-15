import { describe, expect, it } from "vitest";
import type { Folder, SpecialUse } from "./model.ts";
import {
  UNDO_TOAST_MS,
  UNDO_TTL_MS,
  mergeRecord,
  planUndo,
  recordGroups,
  undoResultText,
  undoToastText,
  type UndoGroup,
  type UndoRecord,
  type UndoRow,
} from "./undo.ts";

function folder(path: string, specialUse: SpecialUse | null, selectable = true, accountId = "a1"): Folder {
  return { accountId, path, name: path.split("/").pop()!, specialUse, selectable, unreadCount: 0, totalCount: 0 };
}

const GMAIL = [
  folder("INBOX", "inbox"),
  folder("[Gmail]/All Mail", "all"),
  folder("[Gmail]/Trash", "trash"),
  folder("[Gmail]/Spam", "junk"),
  folder("Work", null),
  folder("[Gmail]", null, false),
];
const foldersOf = (list: Folder[]) => (_accountId: string) => list;

function row(id: string, folderPath: string, extra: Partial<UndoRow> = {}): UndoRow {
  return { id, accountId: "a1", folder: folderPath, uid: 10, movePending: null, isRead: false, isFlagged: false, ...extra };
}
const rowsOf = (...list: UndoRow[]) => new Map(list.map((r) => [r.id, r]));

function moveRecord(source: string, destination: string, destinationUse: SpecialUse | null, ids: string[]): UndoRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    action: "move",
    groups: [{ accountId: "a1", source, destination, destinationUse, ids }],
    createdAt: "2026-11-15T10:00:00.000Z",
    expiresAt: "2026-11-15T10:10:00.000Z",
  };
}

describe("constants", () => {
  it("are the spec's", () => {
    expect(UNDO_TTL_MS).toBe(600_000);
    expect(UNDO_TOAST_MS).toBe(10_000);
  });
});

describe("planUndo: moves", () => {
  it("cancels a move not pushed yet", () => {
    const record = moveRecord("INBOX", "[Gmail]/Trash", "trash", ["m1", "m2"]);
    const rows = rowsOf(row("m1", "INBOX", { movePending: "[Gmail]/Trash" }), row("m2", "INBOX", { movePending: "[Gmail]/Trash" }));
    expect(planUndo(record, rows, foldersOf(GMAIL))).toEqual({
      steps: [{ kind: "cancel_pending", accountId: "a1", folder: "INBOX", destination: "[Gmail]/Trash", ids: ["m1", "m2"] }],
      skipped: [],
    });
  });

  it("copies back only an archive undone from All Mail", () => {
    const record = moveRecord("INBOX", "[Gmail]/All Mail", "all", ["m1"]);
    expect(planUndo(record, rowsOf(row("m1", "[Gmail]/All Mail")), foldersOf(GMAIL)).steps).toEqual([
      { kind: "move_back", accountId: "a1", from: "[Gmail]/All Mail", to: "INBOX", ids: ["m1"], copyIfGmail: true },
    ]);
  });

  it("moves back out of a label, Trash and Spam (no copy)", () => {
    for (const [destination, use] of [
      ["Work", null],
      ["[Gmail]/Trash", "trash"],
      ["[Gmail]/Spam", "junk"],
    ] as const) {
      const record = moveRecord("INBOX", destination, use, ["m1"]);
      expect(planUndo(record, rowsOf(row("m1", destination)), foldersOf(GMAIL)).steps, destination).toEqual([
        { kind: "move_back", accountId: "a1", from: destination, to: "INBOX", ids: ["m1"], copyIfGmail: false },
      ]);
    }
  });

  it("moves a Not spam back to Spam without a copy", () => {
    const record = { ...moveRecord("[Gmail]/Spam", "INBOX", "inbox", ["m1"]), action: "not_spam" as const };
    expect(planUndo(record, rowsOf(row("m1", "INBOX")), foldersOf(GMAIL)).steps).toEqual([
      { kind: "move_back", accountId: "a1", from: "INBOX", to: "[Gmail]/Spam", ids: ["m1"], copyIfGmail: false },
    ]);
  });

  it("plans a move back for a detached row too", () => {
    const record = moveRecord("INBOX", "Work", null, ["m1"]);
    expect(planUndo(record, rowsOf(row("m1", "Work", { uid: null })), foldersOf(GMAIL)).steps).toEqual([
      { kind: "move_back", accountId: "a1", from: "Work", to: "INBOX", ids: ["m1"], copyIfGmail: false },
    ]);
  });

  it("does nothing for a row already back", () => {
    const record = moveRecord("INBOX", "Work", null, ["m1"]);
    expect(planUndo(record, rowsOf(row("m1", "INBOX")), foldersOf(GMAIL))).toEqual({ steps: [], skipped: [] });
  });

  it("skips rows moved elsewhere or gone", () => {
    const record = moveRecord("INBOX", "Work", null, ["m1", "m2", "m3", "m4"]);
    const rows = rowsOf(
      row("m1", "[Gmail]/Trash"),
      row("m2", "Work", { movePending: "[Gmail]/Trash" }),
      row("m3", "INBOX", { movePending: "[Gmail]/Spam" }),
    );
    expect(planUndo(record, rows, foldersOf(GMAIL))).toEqual({
      steps: [],
      skipped: [
        { accountId: "a1", folder: "INBOX", count: 3, reason: "moved_elsewhere" },
        { accountId: "a1", folder: "INBOX", count: 1, reason: "gone" },
      ],
    });
  });

  it("skips when the source folder is gone or cannot hold messages", () => {
    const gone = moveRecord("Old", "Work", null, ["m1"]);
    expect(planUndo(gone, rowsOf(row("m1", "Work")), foldersOf(GMAIL)).skipped).toEqual([
      { accountId: "a1", folder: "Old", count: 1, reason: "folder_gone" },
    ]);
    const noselect = moveRecord("[Gmail]", "Work", null, ["m1"]);
    expect(planUndo(noselect, rowsOf(row("m1", "Work")), foldersOf(GMAIL)).skipped).toEqual([
      { accountId: "a1", folder: "[Gmail]", count: 1, reason: "folder_gone" },
    ]);
  });

  it("splits a mixed group into its steps", () => {
    const record = moveRecord("INBOX", "[Gmail]/All Mail", "all", ["m1", "m2", "m3"]);
    const rows = rowsOf(
      row("m1", "INBOX", { movePending: "[Gmail]/All Mail" }),
      row("m2", "[Gmail]/All Mail"),
      row("m3", "INBOX"),
    );
    expect(planUndo(record, rows, foldersOf(GMAIL)).steps).toEqual([
      { kind: "cancel_pending", accountId: "a1", folder: "INBOX", destination: "[Gmail]/All Mail", ids: ["m1"] },
      { kind: "move_back", accountId: "a1", from: "[Gmail]/All Mail", to: "INBOX", ids: ["m2"], copyIfGmail: true },
    ]);
  });

  it("keeps accounts apart", () => {
    const record: UndoRecord = {
      ...moveRecord("INBOX", "Archive", "archive", ["m1"]),
      groups: [
        { accountId: "a1", source: "INBOX", destination: "Archive", destinationUse: "archive", ids: ["m1"] },
        { accountId: "a2", source: "INBOX", destination: "Archive", destinationUse: "archive", ids: ["m2"] },
      ],
    };
    const folders = (accountId: string) => [folder("INBOX", "inbox", true, accountId), folder("Archive", "archive", true, accountId)];
    const rows = rowsOf(row("m1", "Archive"), row("m2", "Archive", { accountId: "a2" }));
    expect(planUndo(record, rows, folders).steps).toEqual([
      { kind: "move_back", accountId: "a1", from: "Archive", to: "INBOX", ids: ["m1"], copyIfGmail: false },
      { kind: "move_back", accountId: "a2", from: "Archive", to: "INBOX", ids: ["m2"], copyIfGmail: false },
    ]);
  });
});

describe("planUndo: flags", () => {
  function flagRecord(action: UndoRecord["action"], prior: UndoGroup["prior"]): UndoRecord {
    return {
      id: "00000000-0000-4000-8000-000000000002",
      action,
      groups: [{ accountId: "a1", source: "INBOX", destination: null, destinationUse: null, ids: prior!.map((p) => p.id), prior }],
      createdAt: "2026-11-15T10:00:00.000Z",
      expiresAt: "2026-11-15T10:10:00.000Z",
    };
  }

  it("restores the prior value where the action's value still holds", () => {
    const record = flagRecord("mark_read", [
      { id: "m1", seen: false, flagged: false },
      { id: "m2", seen: false, flagged: true },
    ]);
    const rows = rowsOf(row("m1", "INBOX", { isRead: true }), row("m2", "INBOX", { isRead: true, isFlagged: true }));
    expect(planUndo(record, rows, foldersOf(GMAIL))).toEqual({
      steps: [{ kind: "flags", ids: ["m1", "m2"], change: { seen: false } }],
      skipped: [],
    });
  });

  it("skips quietly what changed since, was already so, or is gone", () => {
    const record = flagRecord("flag", [
      { id: "m1", seen: false, flagged: false },
      { id: "m2", seen: false, flagged: false },
      { id: "m3", seen: false, flagged: true },
      { id: "m4", seen: false, flagged: false },
    ]);
    const rows = rowsOf(
      row("m1", "INBOX", { isFlagged: true }),
      row("m2", "INBOX", { isFlagged: false }),
      row("m3", "INBOX", { isFlagged: true }),
    );
    expect(planUndo(record, rows, foldersOf(GMAIL))).toEqual({
      steps: [{ kind: "flags", ids: ["m1"], change: { flagged: false } }],
      skipped: [],
    });
  });

  it("gives no step when nothing is left to restore", () => {
    const record = flagRecord("mark_unread", [{ id: "m1", seen: true, flagged: false }]);
    expect(planUndo(record, rowsOf(row("m1", "INBOX", { isRead: true })), foldersOf(GMAIL)).steps).toEqual([]);
  });
});

describe("recordGroups", () => {
  it("records only groups that queued something, with paths and priors", () => {
    const groups = recordGroups(
      "archive",
      [
        { accountId: "a1", folder: "INBOX", ids: ["m1", "m2"], queued: 2, destinationPath: "[Gmail]/All Mail", destinationUse: "all" },
        { accountId: "a2", folder: "INBOX", ids: ["m3"], queued: 0, destinationPath: null, destinationUse: null },
      ],
      new Map(),
    );
    expect(groups).toEqual([
      { accountId: "a1", source: "INBOX", destination: "[Gmail]/All Mail", destinationUse: "all", ids: ["m1", "m2"] },
    ]);
  });

  it("keeps each id's prior flags for a flag change", () => {
    const groups = recordGroups(
      "flag",
      [{ accountId: "a1", folder: "INBOX", ids: ["m1", "m2"], queued: 2, destinationPath: null, destinationUse: null }],
      new Map([
        ["m1", { seen: true, flagged: false }],
        ["m2", { seen: false, flagged: true }],
      ]),
    );
    expect(groups).toEqual([
      {
        accountId: "a1",
        source: "INBOX",
        destination: null,
        destinationUse: null,
        ids: ["m1", "m2"],
        prior: [
          { id: "m1", seen: true, flagged: false },
          { id: "m2", seen: false, flagged: true },
        ],
      },
    ]);
  });
});

describe("mergeRecord", () => {
  const idA = "00000000-0000-4000-8000-00000000000a";
  const idB = "00000000-0000-4000-8000-00000000000b";
  const group = (ids: string[]): UndoGroup => ({ accountId: "a1", source: "INBOX", destination: "Work", destinationUse: null, ids });
  const t0 = new Date("2026-11-15T10:00:00.000Z");
  const t1 = new Date("2026-11-15T10:00:02.000Z");

  it("starts a record that expires after the window", () => {
    expect(mergeRecord(null, idA, "move", [group(["m1"])], t0)).toEqual({
      id: idA,
      action: "move",
      groups: [group(["m1"])],
      createdAt: "2026-11-15T10:00:00.000Z",
      expiresAt: "2026-11-15T10:10:00.000Z",
    });
  });

  it("appends the chunks of one batch and keeps the first expiry", () => {
    const first = mergeRecord(null, idA, "move", [group(["m1"])], t0);
    const merged = mergeRecord(first, idA, "move", [group(["m2"])], t1);
    expect(merged!.groups).toEqual([group(["m1"]), group(["m2"])]);
    expect(merged!.expiresAt).toBe("2026-11-15T10:10:00.000Z");
  });

  it("replaces the record for a new id", () => {
    const first = mergeRecord(null, idA, "move", [group(["m1"])], t0);
    const next = mergeRecord(first, idB, "delete", [group(["m2"])], t1);
    expect(next).toEqual({
      id: idB,
      action: "delete",
      groups: [group(["m2"])],
      createdAt: "2026-11-15T10:00:02.000Z",
      expiresAt: "2026-11-15T10:10:02.000Z",
    });
  });

  it("starts again when the same id has expired", () => {
    const first = mergeRecord(null, idA, "move", [group(["m1"])], t0);
    const late = new Date(t0.getTime() + UNDO_TTL_MS + 1);
    expect(mergeRecord(first, idA, "move", [group(["m2"])], late)!.groups).toEqual([group(["m2"])]);
  });

  it("records nothing for groups that queued nothing", () => {
    const first = mergeRecord(null, idA, "move", [group(["m1"])], t0);
    expect(mergeRecord(first, idB, "move", [], t1)).toBe(first);
    expect(mergeRecord(null, idB, "move", [], t1)).toBeNull();
  });
});

describe("texts", () => {
  it("names each action", () => {
    expect(undoToastText("archive", 1, null)).toBe("Archived 1 conversation");
    expect(undoToastText("archive", 3, null)).toBe("Archived 3 conversations");
    expect(undoToastText("delete", 2, "Trash")).toBe("Moved 2 conversations to Trash");
    expect(undoToastText("spam", 2, "Spam")).toBe("Marked 2 conversations as spam");
    expect(undoToastText("not_spam", 1, "Inbox")).toBe("Moved 1 conversation to Inbox");
    expect(undoToastText("move", 4, "Work")).toBe("Moved 4 conversations to Work");
    expect(undoToastText("mark_read", 2, null)).toBe("Marked 2 conversations read");
    expect(undoToastText("mark_unread", 2, null)).toBe("Marked 2 conversations unread");
    expect(undoToastText("flag", 2, null)).toBe("Starred 2 conversations");
    expect(undoToastText("unflag", 2, null)).toBe("Unstarred 2 conversations");
  });

  it("sums the result", () => {
    expect(undoResultText({ outcome: "done", restored: 3, skipped: [], failed: 0 })).toBe("Undone");
    expect(
      undoResultText({
        outcome: "done",
        restored: 2,
        skipped: [
          { reason: "moved_elsewhere", count: 1 },
          { reason: "gone", count: 1 },
        ],
        failed: 0,
      }),
    ).toBe("Undone for 2 of 4 messages · moved elsewhere");
    expect(undoResultText({ outcome: "done", restored: 1, skipped: [{ reason: "folder_gone", count: 2 }], failed: 0 })).toBe(
      "Undone for 1 of 3 messages · folder no longer exists",
    );
    expect(
      undoResultText({ outcome: "done", restored: 0, skipped: [{ reason: "not_synced", count: 1 }], failed: 2 }),
    ).toBe("Undone for 0 of 3 messages · not synced yet; try again in a minute, could not reach the server; try Undo again");
    expect(undoResultText({ outcome: "pending", restored: 0, skipped: [], failed: 0 })).toBe(
      "Undo will finish after the current sync",
    );
    expect(undoResultText({ outcome: "nothing", restored: 0, skipped: [], failed: 0 })).toBe("Nothing to undo");
  });
});
