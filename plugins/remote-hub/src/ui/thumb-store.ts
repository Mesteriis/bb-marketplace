// The small pictures of the open sessions, by desk session id. The pane that shows a session fills its entry; BB's sidebar
// (a separate React root) reads them. In memory only.
import { useSyncExternalStore } from "react";
import { sameThumb, type Thumb } from "../core/thumb.ts";

export interface ThumbStore {
  get(): Readonly<Record<string, Thumb>>;
  subscribe(listener: () => void): () => void;
  set(id: string, thumb: Thumb): void;
  drop(id: string): void;
}

export function createThumbStore(): ThumbStore {
  let state: Readonly<Record<string, Thumb>> = {};
  const listeners = new Set<() => void>();
  const apply = (next: Readonly<Record<string, Thumb>>): void => {
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set: (id, thumb) => {
      if (!sameThumb(state[id], thumb)) apply({ ...state, [id]: thumb });
    },
    drop: (id) => {
      if (!(id in state)) return;
      const { [id]: _gone, ...rest } = state;
      apply(rest);
    },
  };
}

export const thumbStore = createThumbStore();

export function useThumbs(store: ThumbStore = thumbStore): Readonly<Record<string, Thumb>> {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
