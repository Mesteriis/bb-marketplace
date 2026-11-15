import { describe, expect, it } from "vitest";
import { flagChangeOf } from "./actions.ts";
import type { Folder, MessageAction, SpecialUse } from "./model.ts";
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
    groups: [{ accountId: "a1", kind: "move", change: null, source, destination, destinationUse, ids }],
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

  it("never copies into Trash or Spam: an All Mail row that came from there moves back", () => {
    for (const source of ["[Gmail]/Trash", "[Gmail]/Spam"]) {
      const record = moveRecord(source, "[Gmail]/All Mail", "all", ["m1"]);
      expect(planUndo(record, rowsOf(row("m1", "[Gmail]/All Mail")), foldersOf(GMAIL)).steps, source).toEqual([
        { kind: "move_back", accountId: "a1", from: "[Gmail]/All Mail", to: source, ids: ["m1"], copyIfGmail: false },
      ]);
    }
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
        { accountId: "a1", kind: "move", change: null, source: "INBOX", destination: "Archive", destinationUse: "archive", ids: ["m1"] },
        { accountId: "a2", kind: "move", change: null, source: "INBOX", destination: "Archive", destinationUse: "archive", ids: ["m2"] },
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
      groups: [
        {
          accountId: "a1",
          kind: "flags",
          change: flagChangeOf(action as MessageAction),
          source: "INBOX",
          destination: null,
          destinationUse: null,
          ids: prior!.map((p) => p.id),
          prior,
        },
      ],
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
      { accountId: "a1", kind: "move", change: null, source: "INBOX", destination: "[Gmail]/All Mail", destinationUse: "all", ids: ["m1", "m2"] },
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
        kind: "flags",
        change: { flagged: true },
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
  const group = (ids: string[]): UndoGroup => ({
    accountId: "a1",
    kind: "move",
    change: null,
    source: "INBOX",
    destination: "Work",
    destinationUse: null,
    ids,
  });
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

  it("a block that moved nothing still records its rule", () => {
    const record = mergeRecord(null, idA, "block", [], t0, "rule_1");
    expect(record).toMatchObject({ id: idA, action: "block", groups: [], ruleId: "rule_1" });
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
    ).toBe("Undone for 2 of 4 messages \u00b7 moved elsewhere");
    expect(undoResultText({ outcome: "done", restored: 1, skipped: [{ reason: "folder_gone", count: 2 }], failed: 0 })).toBe(
      "Undone for 1 of 3 messages \u00b7 folder no longer exists",
    );
    expect(
      undoResultText({ outcome: "done", restored: 0, skipped: [{ reason: "not_synced", count: 1 }], failed: 2 }),
    ).toBe("Undone for 0 of 3 messages \u00b7 not synced yet; try again in a minute, could not reach the server; try Undo again");
    expect(undoResultText({ outcome: "pending", restored: 0, skipped: [], failed: 0 })).toBe(
      "Undo will finish after the current sync",
    );
    expect(undoResultText({ outcome: "nothing", restored: 0, skipped: [], failed: 0 })).toBe("Nothing to undo");
  });
});

describe("slice 3e: groups carry their own kind", () => {
  const SNOOZED = [...GMAIL, folder("Snoozed (Makosh)", null)];
  const g = (extra: Partial<UndoGroup> & Pick<UndoGroup, "kind" | "ids">): UndoGroup => ({
    accountId: "a1",
    change: null,
    source: "INBOX",
    destination: null,
    destinationUse: null,
    ...extra,
  });

  it("plans a mixed triage record group by group", () => {
    const record: UndoRecord = {
      id: "00000000-0000-4000-8000-000000000003",
      action: "triage",
      groups: [
        g({ kind: "move", ids: ["a"], destination: "[Gmail]/All Mail", destinationUse: "all" }),
        g({ kind: "move", ids: ["s"], destination: "[Gmail]/Spam", destinationUse: "junk" }),
        g({ kind: "flags", ids: ["r1", "r2"], change: { seen: true }, prior: [
          { id: "r1", seen: false, flagged: false },
          { id: "r2", seen: false, flagged: false },
        ] }),
        g({ kind: "snooze", ids: ["z1", "z2"], destination: "Snoozed (Makosh)", snoozeIds: ["z1", "z2"] }),
      ],
      createdAt: "2026-11-15T10:00:00.000Z",
      expiresAt: "2026-11-15T10:10:00.000Z",
    };
    const rows = rowsOf(
      row("a", "[Gmail]/All Mail"),
      row("s", "INBOX", { movePending: "[Gmail]/Spam" }),
      row("r1", "INBOX", { isRead: true }),
      // Marked unread again on the phone: left alone.
      row("r2", "INBOX", { isRead: false }),
      row("z1", "INBOX", { movePending: "Snoozed (Makosh)" }),
      row("z2", "Snoozed (Makosh)"),
    );
    expect(planUndo(record, rows, foldersOf(SNOOZED))).toEqual({
      steps: [
        { kind: "move_back", accountId: "a1", from: "[Gmail]/All Mail", to: "INBOX", ids: ["a"], copyIfGmail: true },
        { kind: "cancel_pending", accountId: "a1", folder: "INBOX", destination: "[Gmail]/Spam", ids: ["s"] },
        { kind: "flags", ids: ["r1"], change: { seen: false } },
        { kind: "cancel_pending", accountId: "a1", folder: "INBOX", destination: "Snoozed (Makosh)", ids: ["z1"] },
        { kind: "move_back", accountId: "a1", from: "Snoozed (Makosh)", to: "INBOX", ids: ["z2"], copyIfGmail: false },
      ],
      skipped: [],
    });
  });

  it("reads the flag change from the group, not the record's action", () => {
    const record: UndoRecord = {
      id: "00000000-0000-4000-8000-000000000004",
      action: "archive",
      groups: [g({ kind: "flags", ids: ["m1"], change: { flagged: true }, prior: [{ id: "m1", seen: false, flagged: false }] })],
      createdAt: "2026-11-15T10:00:00.000Z",
      expiresAt: "2026-11-15T10:10:00.000Z",
    };
    expect(planUndo(record, rowsOf(row("m1", "INBOX", { isFlagged: true })), foldersOf(GMAIL)).steps).toEqual([
      { kind: "flags", ids: ["m1"], change: { flagged: false } },
    ]);
    // A flags group without a change, and a move group without a destination, plan nothing.
    const empty: UndoRecord = { ...record, groups: [g({ kind: "flags", ids: ["m1"], prior: [{ id: "m1", seen: false, flagged: false }] }), g({ kind: "move", ids: ["m1"] })] };
    expect(planUndo(empty, rowsOf(row("m1", "INBOX", { isFlagged: true })), foldersOf(GMAIL))).toEqual({ steps: [], skipped: [] });
  });

  it("fills kind and change in recordGroups", () => {
    const one = [{ accountId: "a1", folder: "INBOX", ids: ["m1"], queued: 1, destinationPath: "Snoozed", destinationUse: null }];
    expect(recordGroups("archive", one, new Map())[0]).toMatchObject({ kind: "move", change: null });
    expect(recordGroups("mark_unread", one, new Map())[0]).toMatchObject({ kind: "flags", change: { seen: false }, destination: null });
    expect(recordGroups("snooze", one, new Map())[0]).toEqual({
      accountId: "a1",
      kind: "snooze",
      change: null,
      source: "INBOX",
      destination: "Snoozed",
      destinationUse: null,
      ids: ["m1"],
      snoozeIds: ["m1"],
    });
  });

  it("merges one id across actions and keeps the first action unless triage is passed", () => {
    const id = "00000000-0000-4000-8000-00000000000c";
    const t0 = new Date("2026-11-15T10:00:00.000Z");
    const move = g({ kind: "move", ids: ["m1"], destination: "Work" });
    const flags = g({ kind: "flags", ids: ["m2"], change: { seen: true }, prior: [] });
    const first = mergeRecord(null, id, "archive", [move], t0);
    const second = mergeRecord(first, id, "mark_read", [flags], new Date(t0.getTime() + 1_000));
    expect(second).toMatchObject({ id, action: "archive", groups: [move, flags], expiresAt: first!.expiresAt });
    const third = mergeRecord(second, id, "triage", [move], new Date(t0.getTime() + 2_000));
    expect(third?.action).toBe("triage");
    expect(third?.groups).toHaveLength(3);
    // A new id replaces; the same id after expiry starts again.
    expect(mergeRecord(third, "00000000-0000-4000-8000-00000000000d", "spam", [move], t0)?.groups).toEqual([move]);
    expect(mergeRecord(third, id, "spam", [move], new Date(t0.getTime() + UNDO_TTL_MS + 1))).toMatchObject({ action: "spam", groups: [move] });
  });

  it("keeps a block's rule id", () => {
    const id = "00000000-0000-4000-8000-00000000000e";
    const t0 = new Date("2026-11-15T10:00:00.000Z");
    const move = g({ kind: "move", ids: ["m1"], destination: "[Gmail]/Spam", destinationUse: "junk" });
    const record = mergeRecord(null, id, "block", [move], t0, "rule-1");
    expect(record).toMatchObject({ action: "block", ruleId: "rule-1" });
    expect(mergeRecord(record, id, "block", [move], t0)?.ruleId).toBe("rule-1");
    expect(mergeRecord(null, id, "archive", [move], t0)).not.toHaveProperty("ruleId");
  });

  it("names snooze, block and triage in the toast", () => {
    expect(undoToastText("snooze", 2, "Tue 08:00")).toBe("Snoozed until Tue 08:00");
    expect(undoToastText("block", 3, null)).toBe("Blocked \u00b7 3 conversations moved to Spam");
    expect(undoToastText("block", 1, null)).toBe("Blocked \u00b7 1 conversation moved to Spam");
    expect(undoToastText("block", 0, null)).toBe("Blocked");
    expect(undoToastText("triage", 5, null)).toBe("Applied 5 actions");
    expect(undoToastText("triage", 1, null)).toBe("Applied 1 action");
  });
});
