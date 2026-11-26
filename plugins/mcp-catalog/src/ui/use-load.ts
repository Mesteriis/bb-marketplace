import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "./api";

export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

/** Runs `load` on mount and whenever `tick` changes; the previous data stays visible while it reloads. */
export function useLoad<T>(load: () => Promise<T>, tick: number): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(() => {
    const id = ++latest.current;
    loadRef.current().then(
      (data) => {
        if (id === latest.current) setState({ kind: "ready", data });
      },
      (error) => {
        if (id === latest.current) setState({ kind: "error", message: messageOf(error) });
      },
    );
  }, []);

  useEffect(() => {
    run();
    return () => {
      latest.current++;
    };
  }, [run, tick]);

  return { state, reload: run };
}
