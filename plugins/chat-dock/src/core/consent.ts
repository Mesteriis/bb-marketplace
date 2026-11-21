// Whether the user turned the embedded mode on. Off by default: BB's built-in
// Browser keeps one sign-in for every tab, and agent tools can open and drive
// tabs with that sign-in. The choice is kept in memory only, so no setting,
// CLI command or RPC call can change it, and it ends with the plugin's UI: a
// disable, a reload or a restart of BB turns the mode off again.

export interface Consent {
  granted(): boolean;
  subscribe(listener: () => void): () => void;
  grant(): void;
  withdraw(): void;
}

export function createConsent(): Consent {
  const listeners = new Set<() => void>();
  let on = false;

  function set(next: boolean): void {
    if (on === next) return;
    on = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    granted: () => on,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    grant: () => set(true),
    withdraw: () => set(false),
  };
}
