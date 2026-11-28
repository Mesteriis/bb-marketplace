// What the core needs from its host: where the marker lives, which threads
// exist, and the time.
import type { GuardState, Scope } from "./state.ts";

/** One line of the guard's journal. */
export interface LogEvent {
  event: "open" | "close" | "resync";
  scope: Scope | null;
  root: string | null;
  until: number | null;
}

export type StoreUnavailableReason = "not_configured" | "not_writable" | "locked";

/** The marker cannot be written; the guard stays as it was. */
export class StoreUnavailable extends Error {
  readonly reason: StoreUnavailableReason;
  constructor(reason: StoreUnavailableReason) {
    super(`guard state is unavailable: ${reason}`);
    this.name = "StoreUnavailable";
    this.reason = reason;
  }
}

/** The thread runs on a machine that does not hold the marker. */
export class NotLocal extends Error {
  constructor() {
    super("the thread does not run on the machine that holds the guard state");
    this.name = "NotLocal";
  }
}

export interface StateStore {
  /** Whether the marker's location is known and its directory can be written right now. */
  writable(): Promise<boolean>;
  /** Never throws: an unreadable marker reads as closed. */
  read(): Promise<GuardState>;
  /**
   * Read, change, write under the lock. A change that returns its argument
   * writes nothing and logs nothing. A journal line that depends on what was
   * open is built from the state read under the lock.
   */
  update(
    change: (state: GuardState) => GuardState,
    log: LogEvent | ((before: GuardState) => LogEvent),
  ): Promise<GuardState>;
}

export interface ThreadDirectory {
  /** Direct children of a thread. */
  children(threadId: string): Promise<readonly string[]>;
  /** Whether the thread runs on the machine that holds the marker. */
  isLocal(threadId: string): Promise<boolean>;
}

/** Unix seconds. */
export type Clock = () => number;
