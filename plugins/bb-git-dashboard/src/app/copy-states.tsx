import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { Copy } from "../core/workspace.ts";

type State = {ahead: number; behind: number; files: number};
const limit = 50;
const parallel = 4;
const settle = 800;

/**
 * Each copy's local state for the projects tree: `git status` on its machine, no forge. All copies (up to 50, four at a
 * time) when the list changes; afterwards only the copy a change signal names, once the signals settle. A copy that
 * is not read has no state, and the tree shows none for it.
 */
export function useCopyStates(copies: Copy[], signal: string): Map<string, State> {
  const client = useRpc<typeof rpc>();
  const [states, setStates] = useState<Map<string, State>>(new Map());
  const generation = useRef(0);
  const changed = useRef<Set<string | null>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<Copy[]>([]);
  const read = useCallback(async (copy: Copy) => {
    const result = await client.call("git", {copyId: copy.id, action: {kind: "status"}}).catch(() => null);
    return result?.ok ? {ahead: result.value.ahead ?? 0, behind: result.value.behind ?? 0, files: result.value.files?.length ?? 0} : null;
  }, [client]);
  const readAll = useCallback(async (list: Copy[], call: number) => {
    const next = new Map<string, State>();
    let index = 0;
    await Promise.all(Array.from({length: Math.min(parallel, list.length)}, async () => {
      while (index < list.length && call === generation.current) {
        const copy = list[index++]!;
        const state = await read(copy);
        if (state) next.set(copy.id, state);
      }
    }));
    return next;
  }, [read]);
  const key = copies.map(copy => copy.id).join(",");
  useEffect(() => {
    const call = ++generation.current;
    shown.current = copies.slice(0, limit);
    void readAll(shown.current, call).then(next => { if (call === generation.current) setStates(next); });
  }, [key, readAll]);
  useRealtime(signal, useCallback((payload: unknown) => {
    const copyId = payload && typeof payload === "object" && "copyId" in payload && typeof payload.copyId === "string" ? payload.copyId : null;
    changed.current.add(copyId);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const ids = changed.current;
      changed.current = new Set();
      const call = generation.current;
      // A signal without a copy (a bulk fetch) reads them all again; otherwise only the copies it named.
      const list = ids.has(null) ? shown.current : shown.current.filter(copy => ids.has(copy.id));
      void readAll(list, call).then(next => {
        if (call !== generation.current) return;
        setStates(previous => { const merged = new Map(previous); for (const copy of list) { const state = next.get(copy.id); if (state) merged.set(copy.id, state); else merged.delete(copy.id); } return merged; });
      });
    }, settle);
  }, [readAll]));
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return states;
}
