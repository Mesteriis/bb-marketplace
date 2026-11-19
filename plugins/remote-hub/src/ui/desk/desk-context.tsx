// Which desk a pane belongs to. The plugin has one (deskStore); tests give each case its own.
import { createContext, useContext } from "react";
import { deskStore, type DeskStore } from "../desk-store.ts";

export const DeskContext = createContext<DeskStore>(deskStore);

export function useDeskStore(): DeskStore {
  return useContext(DeskContext);
}

/** How the owner closes a session from anywhere (the sidebar, a pane): the host that shows it registers the real action. */
const closers = new Map<string, () => void | Promise<void>>();

export function registerCloser(id: string, close: () => void | Promise<void>): () => void {
  closers.set(id, close);
  return () => {
    if (closers.get(id) === close) closers.delete(id);
  };
}

/** Closes the session `id`: its host disconnects it and takes it off the desk. Without a host the entry is just removed. */
export function closeDeskSession(store: DeskStore, id: string): void {
  const close = closers.get(id);
  if (close === undefined) store.close(id);
  else void close();
}
