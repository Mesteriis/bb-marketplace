import { useCallback, useEffect, useRef, useState } from "react";

/** Seconds a failed read asks to wait before it is tried again: only a rate limit says so. */
export function retryDelay(error: unknown): number | null {
  const value = (error as {retryIn?: unknown} | null)?.retryIn;
  return typeof value === "number" && value >= 1 && value <= 120 ? Math.ceil(value) : null;
}

/**
 * After a rate-limited read, counts down the seconds the forge asked for and calls `retry` once they pass.
 * `schedule` returns false for any other failure, which the page reports as usual.
 */
export function useAutoRetry(retry: () => void) {
  const [left, setLeft] = useState<number | null>(null);
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (left === null) return;
    if (left <= 0) { setLeft(null); latest.current(); return; }
    const timer = setTimeout(() => setLeft(value => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const schedule = useCallback((error: unknown) => {
    const delay = retryDelay(error);
    if (delay === null) return false;
    setLeft(delay);
    return true;
  }, []);
  const cancel = useCallback(() => setLeft(null), []);
  return {left, schedule, cancel};
}
