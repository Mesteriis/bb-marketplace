// What BB's sidebar asks of the page. They are separate React roots, so a request travels through this bus; the page
// (which owns the sessions and the secondary screens) carries it out. A request made while no page is mounted is kept
// until one subscribes, so a click in the sidebar is never lost to mount order.
import type { PveConsoleRequest } from "./pve-api.ts";

export type HubCommand =
  | { type: "connect"; profileId: string }
  | { type: "console"; profileId: string; connectionName: string; request: PveConsoleRequest; title: string }
  | { type: "edit"; profileId: string | null }
  | { type: "add-pve" }
  | { type: "credentials" }
  | { type: "import" }
  | { type: "agents" }
  | { type: "desk" };

export interface HubBus {
  send(command: HubCommand): void;
  subscribe(handler: (command: HubCommand) => void): () => void;
  /** The page changed the saved connections (saved, deleted, imported): lists elsewhere reload. */
  changed(): void;
  onChanged(listener: () => void): () => void;
}

export function createHubBus(): HubBus {
  const handlers = new Set<(command: HubCommand) => void>();
  const changeListeners = new Set<() => void>();
  let pending: HubCommand[] = [];
  return {
    send: (command) => {
      if (handlers.size === 0) {
        pending.push(command);
        return;
      }
      for (const h of [...handlers]) h(command);
    },
    subscribe: (handler) => {
      handlers.add(handler);
      const waiting = pending;
      pending = [];
      for (const c of waiting) handler(c);
      return () => void handlers.delete(handler);
    },
    changed: () => {
      for (const l of [...changeListeners]) l();
    },
    onChanged: (listener) => {
      changeListeners.add(listener);
      return () => void changeListeners.delete(listener);
    },
  };
}

export const hubBus = createHubBus();
