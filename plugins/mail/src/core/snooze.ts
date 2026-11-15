// Snooze (slice 3e): the folder's name, the presets the page offers, and
// the step for each snooze row from where its message is now. Pure; the
// snooze clock runs the steps through the account's queue (spec "Snooze",
// state table, and resolution 18).
import type { AccountPreset, Folder } from "./model.ts";

export const SNOOZE_MIN_MS = 5 * 60_000;
export const SNOOZE_MAX_MS = 365 * 86_400_000;
export const SNOOZES_MAX_PER_ACCOUNT = 2_000;
/** Rows one account's tick plans at most. */
export const SNOOZE_TICK_LIMIT = 200;
/** A move back cancelled after refusals is tried again after this. */
export const SNOOZE_RETRY_MS = 15 * 60_000;

/** The folder a snooze confirmation creates (spec resolution 8). */
export function snoozeFolderName(preset: AccountPreset): string {
  return preset === "gmail" ? "Snoozed (Makosh)" : "Snoozed";
}

/** The name tried once when the server refuses the first one; Gmail has none. */
export function snoozeFallbackName(preset: AccountPreset): string | null {
  return preset === "gmail" ? null : "Snoozed (Makosh)";
}

export type SnoozeState = "moving" | "snoozed" | "returning";

export type SnoozeRow = {
  messageId: string;
  accountId: string;
  /** The folder the message returns to; a `return` step's `to` replaces it. */
  returnTo: string;
  dueAt: string;
  state: SnoozeState;
};

/** A snooze with its message row as stored now; `row` null: the message is not stored any more. */
export type SnoozeView = {
  snooze: SnoozeRow;
  row: { folder: string; uid: number | null; movePending: string | null } | null;
};

/**
 * One row's step. `cancel_move`: CAS-cancel the pending move into the snooze
 * folder and delete the snooze. `to_snoozed`: set the state. `return`: queue
 * the move from the snooze folder to `to` with `\Seen` cleared, set the state
 * `returning` and `returnTo = to`. `done`: delete the snooze (it is back; a
 * returning snooze toasts by the notify filter). `drop`: delete it quietly.
 * `rearm`: state `snoozed` with the new due time.
 */
export type SnoozeStep =
  | { kind: "wait"; messageId: string }
  | { kind: "cancel_move"; messageId: string; accountId: string; folder: string; destination: string }
  | { kind: "to_snoozed"; messageId: string }
  | { kind: "return"; messageId: string; accountId: string; from: string; to: string }
  | { kind: "done"; messageId: string }
  | { kind: "drop"; messageId: string }
  | { kind: "rearm"; messageId: string; dueAt: string };

export type SnoozePlanContext = {
  /** The account's snooze folder path. */
  snoozeFolder: string;
  /** The account's Inbox path, where mail returns when `returnTo` is gone. */
  inbox: string;
  folders: readonly Folder[];
  now: Date;
};

/** The step of every view, in order (spec "State machine"). */
export function planSnoozes(views: readonly SnoozeView[], ctx: SnoozePlanContext): SnoozeStep[] {
  return views.map((view) => planOne(view, ctx));
}

function planOne({ snooze, row }: SnoozeView, ctx: SnoozePlanContext): SnoozeStep {
  const messageId = snooze.messageId;
  const due = Date.parse(snooze.dueAt) <= ctx.now.getTime();
  const drop: SnoozeStep = { kind: "drop", messageId };
  const wait: SnoozeStep = { kind: "wait", messageId };
  if (row === null) return drop;
  const inSnoozed = row.folder === ctx.snoozeFolder;

  switch (snooze.state) {
    case "moving":
      if (row.folder === snooze.returnTo && row.movePending === ctx.snoozeFolder) {
        return due
          ? { kind: "cancel_move", messageId, accountId: snooze.accountId, folder: row.folder, destination: ctx.snoozeFolder }
          : wait;
      }
      if (inSnoozed && row.movePending === null) {
        // Detached after a move without UIDPLUS: the destination's sync reattaches it.
        return row.uid === null ? wait : { kind: "to_snoozed", messageId };
      }
      return drop;
    case "snoozed": {
      if (!inSnoozed || row.movePending !== null) return drop;
      if (row.uid === null || !due) return wait;
      const target = ctx.folders.find((f) => f.path === snooze.returnTo);
      const to = target !== undefined && target.selectable && target.path !== ctx.snoozeFolder ? target.path : ctx.inbox;
      return { kind: "return", messageId, accountId: snooze.accountId, from: row.folder, to };
    }
    case "returning":
      if (row.folder === snooze.returnTo && row.movePending === null) return { kind: "done", messageId };
      if (inSnoozed && row.movePending === snooze.returnTo) return wait;
      if (inSnoozed && row.movePending === null) {
        return { kind: "rearm", messageId, dueAt: new Date(ctx.now.getTime() + SNOOZE_RETRY_MS).toISOString() };
      }
      return drop;
  }
}

export type SnoozePresetId = "later_today" | "tomorrow" | "weekend" | "next_week";
export type SnoozePreset = { id: SnoozePresetId; label: string; at: Date };

/**
 * The page's presets in local time: Later today (three hours on, rounded up
 * to the hour; hidden from 18:00), Tomorrow 08:00, This weekend (Saturday
 * 08:00; hidden on Saturday and Sunday), Next week (Monday 08:00).
 */
export function snoozePresets(now: Date, _zone: "local"): SnoozePreset[] {
  const at = (dayOffset: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0, 0);
  const presets: SnoozePreset[] = [];
  if (now.getHours() < 18) {
    const later = new Date(now.getTime() + 3 * 3_600_000);
    if (later.getMinutes() !== 0 || later.getSeconds() !== 0 || later.getMilliseconds() !== 0) {
      later.setHours(later.getHours() + 1, 0, 0, 0);
    }
    presets.push({ id: "later_today", label: "Later today", at: later });
  }
  presets.push({ id: "tomorrow", label: "Tomorrow", at: at(1, 8) });
  const day = now.getDay(); // 0 Sunday … 6 Saturday
  if (day !== 0 && day !== 6) presets.push({ id: "weekend", label: "This weekend", at: at(6 - day, 8) });
  presets.push({ id: "next_week", label: "Next week", at: at(day === 0 ? 1 : 8 - day, 8) });
  return presets;
}

/** Whether `until` (ISO) is 5 minutes to 365 days from now. */
export function validUntil(until: string, now: Date): boolean {
  const time = Date.parse(until);
  if (Number.isNaN(time)) return false;
  const ahead = time - now.getTime();
  return ahead >= SNOOZE_MIN_MS && ahead <= SNOOZE_MAX_MS;
}
