// Undo the last message action (slice 3d): what the server records when an
// action queues something, and, at undo time, the per-row plan from where
// each row is now. Pure; the server keeps the one record in memory and runs
// the steps through the account's queue.
//
// Undo never destroys and never lands elsewhere: a move not pushed yet is
// cancelled, a pushed one is moved back from where the action put it, and
// a row found anywhere else is left alone. UID COPY is used only to undo an
// archive on Gmail (the row now in All Mail, `\All`): adding the source's
// label back is the inverse there, and a COPY removes nothing. A message
// moved to a label, to Trash or to Spam is moved back, which on Gmail also
// takes the label off (owner's decision, 2026-11-15).
import { flagChangeOf } from "./actions.ts";
import type { FlagChange, Folder, MessageAction, SpecialUse } from "./model.ts";

/** How long the last action stays undoable. */
export const UNDO_TTL_MS = 10 * 60 * 1000;
/** How long the page shows the Undo toast. */
export const UNDO_TOAST_MS = 10_000;

/** The ids one action queued in one account and source folder. */
export type UndoGroup = {
  accountId: string;
  /** Folder path the messages were in. */
  source: string;
  /** Move: the destination's path; flag change: null. */
  destination: string | null;
  destinationUse: SpecialUse | null;
  ids: string[];
  /** Flag changes: each id's value before the action. */
  prior?: { id: string; seen: boolean; flagged: boolean }[];
};

export type UndoRecord = {
  /** The page's undoId (a uuid). */
  id: string;
  action: MessageAction;
  groups: UndoGroup[];
  createdAt: string;
  expiresAt: string;
};

/** Where a recorded message is now (store `undoRows`). `uid` null: detached, waiting for reattach. */
export type UndoRow = {
  id: string;
  accountId: string;
  folder: string;
  uid: number | null;
  movePending: string | null;
  isRead: boolean;
  isFlagged: boolean;
};

/**
 * One step of an undo. `move_back` is queued as a move unless `copyIfGmail`
 * is true and the session on `from` reports Gmail: then the row is copied
 * to `to` (spec resolutions 1 and 7, narrowed by the owner to archive undo:
 * `copyIfGmail` is true only when `from` is All Mail and `to` is not Trash
 * or Spam).
 */
export type UndoStep =
  | { kind: "cancel_pending"; accountId: string; folder: string; destination: string; ids: string[] }
  | { kind: "move_back"; accountId: string; from: string; to: string; ids: string[]; copyIfGmail: boolean }
  | { kind: "flags"; ids: string[]; change: FlagChange };

export type UndoSkipReason = "moved_elsewhere" | "gone" | "folder_gone";
export type UndoSkip = { accountId: string; folder: string; count: number; reason: UndoSkipReason };
export type UndoPlan = { steps: UndoStep[]; skipped: UndoSkip[] };

/**
 * The steps for the rows as they are now (spec "Which step for a moved
 * message"): in the source with the move still pending → cancel it; in the
 * destination with nothing pending (pushed, or detached until reattach) →
 * move back, unless the source no longer exists or cannot hold messages;
 * in the source with nothing pending → already back, nothing; anywhere
 * else → `moved_elsewhere`; not stored → `gone`. Flag changes restore the
 * prior value only where the action's value still holds; others are
 * skipped quietly.
 */
export function planUndo(
  record: UndoRecord,
  rows: ReadonlyMap<string, UndoRow>,
  folders: (accountId: string) => Folder[],
): UndoPlan {
  const steps = new Map<string, UndoStep>();
  const skipped = new Map<string, UndoSkip>();
  const skip = (group: UndoGroup, reason: UndoSkipReason) => {
    const key = `${group.accountId}\u0000${group.source}\u0000${reason}`;
    const entry = skipped.get(key) ?? { accountId: group.accountId, folder: group.source, count: 0, reason };
    entry.count += 1;
    skipped.set(key, entry);
  };
  const add = (key: string, make: () => UndoStep, id: string) => {
    let step = steps.get(key);
    if (step === undefined) {
      step = make();
      steps.set(key, step);
    }
    step.ids.push(id);
  };

  const change = flagChangeOf(record.action);
  for (const group of record.groups) {
    if (group.destination === null) {
      if (change !== null) planFlags(group, change, rows, add);
      continue;
    }
    const destination = group.destination;
    const accountFolders = folders(group.accountId);
    const source = accountFolders.find((f) => f.path === group.source);
    const sourceUsable = source !== undefined && source.selectable;
    const nowUse = accountFolders.find((f) => f.path === destination)?.specialUse ?? group.destinationUse;
    // A COPY into Trash or Spam would put a copy there, not undo anything: those move back.
    const copyable = nowUse === "all" && source?.specialUse !== "trash" && source?.specialUse !== "junk";
    for (const id of group.ids) {
      const row = rows.get(id);
      if (row === undefined || row.accountId !== group.accountId) {
        skip(group, "gone");
      } else if (row.folder === group.source && row.movePending === destination) {
        add(
          `cancel\u0000${group.accountId}\u0000${group.source}\u0000${destination}`,
          () => ({ kind: "cancel_pending", accountId: group.accountId, folder: group.source, destination, ids: [] }),
          id,
        );
      } else if (row.folder === group.source && row.movePending === null) {
        // Already back (the move was cancelled after refusals).
      } else if (row.folder === destination && row.movePending === null) {
        if (!sourceUsable) {
          skip(group, "folder_gone");
          continue;
        }
        add(
          `back\u0000${group.accountId}\u0000${destination}\u0000${group.source}`,
          () => ({
            kind: "move_back",
            accountId: group.accountId,
            from: destination,
            to: group.source,
            ids: [],
            copyIfGmail: copyable,
          }),
          id,
        );
      } else {
        skip(group, "moved_elsewhere");
      }
    }
  }
  return { steps: [...steps.values()], skipped: [...skipped.values()] };
}

function planFlags(
  group: UndoGroup,
  change: FlagChange,
  rows: ReadonlyMap<string, UndoRow>,
  add: (key: string, make: () => UndoStep, id: string) => void,
): void {
  for (const prior of group.prior ?? []) {
    const row = rows.get(prior.id);
    if (row === undefined) continue;
    if (change.seen !== undefined) {
      if (prior.seen === change.seen || row.isRead !== change.seen) continue;
      add("flags\u0000seen", () => ({ kind: "flags", ids: [], change: { seen: prior.seen } }), prior.id);
    } else if (change.flagged !== undefined) {
      if (prior.flagged === change.flagged || row.isFlagged !== change.flagged) continue;
      add("flags\u0000flagged", () => ({ kind: "flags", ids: [], change: { flagged: prior.flagged } }), prior.id);
    }
  }
}

/** One message_action group as the server ran it, with the destination's path and role. */
export type RecordableGroup = {
  accountId: string;
  folder: string;
  ids: string[];
  queued: number;
  destinationPath: string | null;
  destinationUse: SpecialUse | null;
};

/** The undo groups of one message_action call: only groups that queued something; flag changes keep each id's prior flags. */
export function recordGroups(
  action: MessageAction,
  groups: RecordableGroup[],
  priors: ReadonlyMap<string, { seen: boolean; flagged: boolean }>,
): UndoGroup[] {
  const flags = flagChangeOf(action) !== null;
  return groups
    .filter((group) => group.queued > 0)
    .map((group) => {
      const recorded: UndoGroup = {
        accountId: group.accountId,
        source: group.folder,
        destination: flags ? null : group.destinationPath,
        destinationUse: flags ? null : group.destinationUse,
        ids: [...group.ids],
      };
      if (flags) {
        recorded.prior = group.ids.flatMap((id) => {
          const prior = priors.get(id);
          return prior === undefined ? [] : [{ id, seen: prior.seen, flagged: prior.flagged }];
        });
      }
      return recorded;
    });
}

/**
 * The slot after a message_action call with `undoId`: the same id (the
 * page's chunks of one batch) appends its groups and keeps the first
 * expiry; a new id, or the same one after it expired, replaces the record.
 * A call that queued nothing leaves the slot as it is.
 */
export function mergeRecord(
  current: UndoRecord | null,
  undoId: string,
  action: MessageAction,
  groups: UndoGroup[],
  now: Date,
): UndoRecord | null {
  if (groups.length === 0) return current;
  const nowIso = now.toISOString();
  if (current !== null && current.id === undoId && current.action === action && current.expiresAt > nowIso) {
    return { ...current, groups: [...current.groups, ...groups] };
  }
  return {
    id: undoId,
    action,
    groups,
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + UNDO_TTL_MS).toISOString(),
  };
}

const plural = (count: number) => `${count} conversation${count === 1 ? "" : "s"}`;

/** The toast after an undoable action. `destinationName`: the folder's name for a move. */
export function undoToastText(action: MessageAction, count: number, destinationName: string | null): string {
  const n = plural(count);
  switch (action) {
    case "archive":
      return `Archived ${n}`;
    case "delete":
      return `Moved ${n} to ${destinationName ?? "Trash"}`;
    case "spam":
      return `Marked ${n} as spam`;
    case "not_spam":
      return `Moved ${n} to ${destinationName ?? "Inbox"}`;
    case "move":
      return `Moved ${n} to ${destinationName ?? "another folder"}`;
    case "mark_read":
      return `Marked ${n} read`;
    case "mark_unread":
      return `Marked ${n} unread`;
    case "flag":
      return `Starred ${n}`;
    case "unflag":
      return `Unstarred ${n}`;
  }
}

/** What an undo did, summed over its groups. `not_synced`: a copy whose row has no uid yet, or whose folder must resync. */
export type UndoResultSummary = {
  outcome: "done" | "pending" | "nothing";
  restored: number;
  skipped: { reason: UndoSkipReason | "not_synced"; count: number }[];
  failed: number;
};

const REASON_TEXT: Record<UndoSkipReason | "not_synced", string> = {
  moved_elsewhere: "moved elsewhere",
  // A row that could not be found again reads as moved elsewhere to the owner.
  gone: "moved elsewhere",
  folder_gone: "folder no longer exists",
  // Put back into the slot (runUndo): Undo can run again once sync caught up.
  not_synced: "not synced yet; try again in a minute",
};

/** The toast after an undo. */
export function undoResultText(result: UndoResultSummary): string {
  if (result.outcome === "nothing") return "Nothing to undo";
  if (result.outcome === "pending") return "Undo will finish after the current sync";
  const left = result.skipped.reduce((sum, entry) => sum + entry.count, 0) + result.failed;
  if (left === 0) return "Undone";
  const reasons: string[] = [];
  for (const entry of result.skipped) {
    const text = REASON_TEXT[entry.reason];
    if (entry.count > 0 && !reasons.includes(text)) reasons.push(text);
  }
  if (result.failed > 0) reasons.push("could not reach the server; try Undo again");
  return `Undone for ${result.restored} of ${result.restored + left} messages · ${reasons.join(", ")}`;
}
