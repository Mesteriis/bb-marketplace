// The one undo slot of the plugin (slice 3d): the owner's last undoable
// action across windows, in memory only. Replaced by the next undoable
// action, consumed by an undo, gone after UNDO_TTL_MS or a restart or plugin
// reload. It holds message ids and folder paths only, never mail content.
import type { Clock, MessageAction } from "../../core/index.ts";
import { mergeRecord, type UndoGroup, type UndoRecord } from "../../core/undo.ts";

export class UndoBook {
  private slot: UndoRecord | null = null;
  /** The id of the last recorded action: a put-back is refused once another action was recorded. */
  private lastId: string | null = null;

  constructor(private readonly clock: Clock) {}

  /** The slot, or null once it expired. */
  private live(): UndoRecord | null {
    if (this.slot !== null && this.slot.expiresAt <= this.clock.now().toISOString()) this.slot = null;
    return this.slot;
  }

  /** Records one message_action call's groups under `undoId` (mergeRecord); false when it queued nothing. */
  record(undoId: string, action: MessageAction, groups: UndoGroup[]): boolean {
    if (groups.length === 0) return false;
    this.slot = mergeRecord(this.live(), undoId, action, groups, this.clock.now());
    this.lastId = undoId;
    return true;
  }

  /** The live record with this id, without consuming it. */
  peek(undoId: string): UndoRecord | null {
    const current = this.live();
    return current !== null && current.id === undoId ? structuredClone(current) : null;
  }

  /** Consumes the live record with this id; null for a stale, foreign or expired id. */
  take(undoId: string): UndoRecord | null {
    const current = this.peek(undoId);
    if (current !== null) this.slot = null;
    return current;
  }

  /**
   * Puts groups that failed back under the same id and expiry, only while no
   * newer record took the slot and the record has not expired. Two put-backs
   * of one record merge.
   */
  putBack(record: UndoRecord): boolean {
    if (record.groups.length === 0 || record.expiresAt <= this.clock.now().toISOString()) return false;
    if (this.lastId !== record.id) return false;
    const current = this.live();
    if (current === null) {
      this.slot = structuredClone(record);
      return true;
    }
    if (current.id !== record.id) return false;
    this.slot = { ...current, groups: [...current.groups, ...structuredClone(record.groups)] };
    return true;
  }

  has(undoId: string): boolean {
    return this.peek(undoId) !== null;
  }
}

/**
 * Undo's second wake (spec resolution 16): after the reverse moves were
 * queued and the first wake pushed them, the account's next round end wakes
 * it once more, so the source folder's sync brings a reattached or copied
 * row back without waiting for the interval.
 */
export class RoundWakes {
  private readonly wanted = new Set<string>();

  constructor(private readonly wake: (accountId: string) => void) {}

  /** Wake the account once more after its next round. */
  after(accountId: string): void {
    this.wanted.add(accountId);
  }

  /** The sync loop's onRoundEnd. */
  roundEnded(accountId: string): void {
    if (this.wanted.delete(accountId)) this.wake(accountId);
  }
}
