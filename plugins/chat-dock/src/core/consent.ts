// Whether the user turned the embedded mode on for this BB client. Off by
// default: BB's built-in Browser keeps one sign-in for every tab, and agent
// tools can open and drive tabs with that sign-in. The choice is kept on the
// client, so no plugin setting, CLI command or RPC call can change it.

export interface ConsentStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Report changes made elsewhere in this client, such as another window. */
  onExternalChange(listener: () => void): () => void;
}

export interface Consent {
  granted(): boolean;
  /** Storage is watched only while someone is subscribed. */
  subscribe(listener: () => void): () => void;
  grant(): void;
  withdraw(): void;
}

export const CONSENT_KEY = "bb-chat-dock:embedded-mode:v1";
const GRANTED = "granted";

export function createConsent(storage: ConsentStorage): Consent {
  const listeners = new Set<() => void>();
  let stopWatching: (() => void) | null = null;

  function granted(): boolean {
    try {
      return storage.get(CONSENT_KEY) === GRANTED;
    } catch {
      return false;
    }
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    granted,
    subscribe(listener) {
      listeners.add(listener);
      if (stopWatching === null) stopWatching = storage.onExternalChange(notify);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopWatching !== null) {
          stopWatching();
          stopWatching = null;
        }
      };
    },
    grant() {
      try {
        storage.set(CONSENT_KEY, GRANTED);
      } catch {
        // Storage refused: the mode stays off.
      }
      notify();
    },
    withdraw() {
      try {
        storage.remove(CONSENT_KEY);
      } catch {
        // Storage refused: `granted` reports what is really stored.
      }
      notify();
    },
  };
}
