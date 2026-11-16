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
import type { LabelDelta } from "./labels.ts";
import type { FlagChange, Folder, MessageAction, SpecialUse } from "./model.ts";

/** How long the last action stays undoable. */
export const UNDO_TTL_MS = 10 * 60 * 1000;
/** How long the page shows the Undo toast. */
export const UNDO_TOAST_MS = 10_000;

/**
 * What a group queued: a move, a \Seen / \Flagged change, a move into the
 * snooze folder, or a Gmail label change (slice 3h, spec resolution 10).
 */
export type UndoGroupKind = "move" | "flags" | "snooze" | "labels";

/** The actions an undo record names; only toast texts read it (spec resolution 14). */
export type UndoAction = MessageAction | "snooze" | "block" | "triage" | "labels";

/**
 * The ids one action queued in one account and source folder. Each group
 * carries its own kind and flag change, so one record can hold the groups of
 * several actions (a triage batch).
 */
export type UndoGroup = {
  accountId: string;
  kind: UndoGroupKind;
  /** `flags` groups: the change the action made; null otherwise. */
  change: FlagChange | null;
  /** Folder path the messages were in. */
  source: string;
  /** Move: the destination's path; flag change: null. */
  destination: string | null;
  destinationUse: SpecialUse | null;
  ids: string[];
  /** Flag changes: each id's value before the action. */
  prior?: { id: string; seen: boolean; flagged: boolean }[];
  /** `snooze` groups: the snooze rows (keyed by message id) the group created; undo deletes them. */
  snoozeIds?: string[];
  /** `labels` groups: per message, only the labels the change really added or removed. */
  labelDeltas?: LabelDelta[];
};

export type UndoRecord = {
  /** The page's undoId (a uuid). */
  id: string;
  /** The first action recorded under this id, or "triage" (toast texts only). */
  action: UndoAction;
  groups: UndoGroup[];
  /** A block: the rule undo deletes first. */
  ruleId?: string;
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
  | { kind: "flags"; ids: string[]; change: FlagChange }
  | { kind: "labels"; accountId: string; ids: string[]; changes: LabelUndoChange[] };

/** One message's inverse label change: add back what was removed, remove what was added. */
export type LabelUndoChange = { messageId: string; add: string[]; remove: string[] };

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

  for (const group of record.groups) {
    if (group.kind === "labels") {
      planLabels(group, rows, steps, () => skip(group, "gone"));
      continue;
    }
    if (group.kind === "flags") {
      if (group.change !== null) planFlags(group, group.change, rows, add);
      continue;
    }
    // A move and a snooze both undo as a move: cancel it, or move back to the source.
    if (group.destination === null) continue;
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

/**
 * A labels group undoes per message: what the change added is removed,
 * what it removed is added back; labels the message had before are never
 * touched (they are not in the deltas). A message no longer stored is skipped.
 */
function planLabels(
  group: UndoGroup,
  rows: ReadonlyMap<string, UndoRow>,
  steps: Map<string, UndoStep>,
  gone: () => void,
): void {
  const key = `labels\u0000${group.accountId}`;
  for (const delta of group.labelDeltas ?? []) {
    const row = rows.get(delta.messageId);
    if (row === undefined || row.accountId !== group.accountId) {
      gone();
      continue;
    }
    let step = steps.get(key);
    if (step === undefined) {
      step = { kind: "labels", accountId: group.accountId, ids: [], changes: [] };
      steps.set(key, step);
    }
    if (step.kind !== "labels") continue;
    step.ids.push(delta.messageId);
    step.changes.push({ messageId: delta.messageId, add: [...delta.removed], remove: [...delta.added] });
  }
}

/** The undo group of one labels_change in one account (none when nothing changed). */
export function labelsGroup(accountId: string, folder: string, deltas: LabelDelta[]): UndoGroup[] {
  if (deltas.length === 0) return [];
  return [
    {
      accountId,
      kind: "labels",
      change: null,
      source: folder,
      destination: null,
      destinationUse: null,
      ids: deltas.map((delta) => delta.messageId),
      labelDeltas: deltas.map((delta) => ({ messageId: delta.messageId, added: [...delta.added], removed: [...delta.removed] })),
    },
  ];
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

/**
 * The undo groups of one message_action (or snooze) call: only groups that
 * queued something, each with its kind and flag change; flag changes keep
 * each id's prior flags, snooze groups list their snooze rows.
 */
export function recordGroups(
  action: MessageAction | "snooze",
  groups: RecordableGroup[],
  priors: ReadonlyMap<string, { seen: boolean; flagged: boolean }>,
): UndoGroup[] {
  const change = action === "snooze" ? null : flagChangeOf(action);
  const flags = change !== null;
  const kind: UndoGroupKind = action === "snooze" ? "snooze" : flags ? "flags" : "move";
  return groups
    .filter((group) => group.queued > 0)
    .map((group) => {
      const recorded: UndoGroup = {
        accountId: group.accountId,
        kind,
        change,
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
      if (kind === "snooze") recorded.snoozeIds = [...group.ids];
      return recorded;
    });
}

/**
 * The slot after an undoable call with `undoId`: the same unexpired id (the
 * page's chunks of one batch, or a triage batch's groups) appends its groups
 * whatever the action, keeps the first expiry and the first action, which
 * becomes "triage" only when the caller passes it; a new id, or the same one
 * after it expired, replaces the record. A call that queued nothing leaves
 * the slot as it is, unless it carries `ruleId` (a block's new rule, kept
 * once set).
 */
export function mergeRecord(
  current: UndoRecord | null,
  undoId: string,
  action: UndoAction,
  groups: UndoGroup[],
  now: Date,
  ruleId?: string,
): UndoRecord | null {
  // A block that moved nothing is still undoable: its rule goes.
  if (groups.length === 0 && ruleId === undefined) return current;
  const nowIso = now.toISOString();
  if (current !== null && current.id === undoId && current.expiresAt > nowIso) {
    const merged: UndoRecord = {
      ...current,
      action: action === "triage" ? "triage" : current.action,
      groups: [...current.groups, ...groups],
    };
    if (merged.ruleId === undefined && ruleId !== undefined) merged.ruleId = ruleId;
    return merged;
  }
  const record: UndoRecord = {
    id: undoId,
    action,
    groups,
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + UNDO_TTL_MS).toISOString(),
  };
  if (ruleId !== undefined) record.ruleId = ruleId;
  return record;
}

const plural = (count: number) => `${count} conversation${count === 1 ? "" : "s"}`;

/**
 * The toast after an undoable action. `detail`: the folder's name for a
 * move, the preformatted return time for a snooze. `count`: conversations,
 * or the number of actions for a triage batch.
 */
export function undoToastText(action: UndoAction, count: number, detail: string | null): string {
  const n = plural(count);
  const destinationName = detail;
  switch (action) {
    case "snooze":
      return `Snoozed until ${detail ?? "later"}`;
    case "block":
      return count === 0 ? "Blocked" : `Blocked \u00b7 ${n} moved to Spam`;
    case "labels":
      return "Labels changed";
    case "triage":
      return `Applied ${count} action${count === 1 ? "" : "s"}`;
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
