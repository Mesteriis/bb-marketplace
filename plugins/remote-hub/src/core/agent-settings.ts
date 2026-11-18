// The plugin-wide setting about how agents act (stage 4c): "agents may act only while I am watching the session". ON by
// default. Only the owner changes it, through the owner RPC of the Remote Hub page (every change is audited there).
// An unreadable store means ON: the strict reading is the default, never the permissive one.
export interface AgentSettingsStore {
  /** The saved choice, or null when none was ever saved. */
  loadRequireWatching(): boolean | null;
  saveRequireWatching(value: boolean): void;
}

export class AgentSettings {
  private value: boolean;
  private readonly listeners = new Set<(requireWatching: boolean) => void>();

  constructor(private readonly store: AgentSettingsStore) {
    let saved: boolean | null = null;
    try {
      saved = store.loadRequireWatching();
    } catch {
      saved = null;
    }
    this.value = saved ?? true;
  }

  requireWatching(): boolean {
    return this.value;
  }

  /** Returns whether the setting changed. A store that cannot save leaves it as it was and throws. */
  setRequireWatching(value: boolean): boolean {
    if (value === this.value) return false;
    this.store.saveRequireWatching(value);
    this.value = value;
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch {
        // one listener's throw must not skip the others
      }
    }
    return true;
  }

  onChange(cb: (requireWatching: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
}
