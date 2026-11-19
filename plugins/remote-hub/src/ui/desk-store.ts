// One desk for the whole plugin bundle: the page and BB's sidebar are separate React roots, so the state they share lives
// here and both read it with useSyncExternalStore. Transitions are the pure functions of core/desk.ts.
import { useSyncExternalStore } from "react";
import { closeSession, emptyDesk, focusSession, openSession, patchSession, setLayout, type DeskLayout, type DeskSession, type DeskState } from "../core/desk.ts";

export interface DeskStore {
  get(): DeskState;
  subscribe(listener: () => void): () => void;
  open(session: DeskSession): void;
  focus(id: string): void;
  close(id: string): void;
  patch(id: string, patch: Parameters<typeof patchSession>[2]): void;
  layout(layout: DeskLayout): void;
}

export function createDeskStore(): DeskStore {
  let state = emptyDesk();
  const listeners = new Set<() => void>();
  const apply = (next: DeskState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    open: (session) => apply(openSession(state, session)),
    focus: (id) => apply(focusSession(state, id)),
    close: (id) => apply(closeSession(state, id)),
    patch: (id, patch) => apply(patchSession(state, id, patch)),
    layout: (layout) => apply(setLayout(state, layout)),
  };
}

/** The plugin's one desk. */
export const deskStore = createDeskStore();

export function useDesk(store: DeskStore = deskStore): DeskState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
