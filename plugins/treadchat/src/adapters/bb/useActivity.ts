import { useEffect, useState } from "react";
import { useRealtimeConnectionState, useSdk } from "@get-bb/plugin-sdk/app";
import { activity, viewedThrough, type Activity } from "../../core/activity";
import { readViewed, storageKey } from "./storage";

export const activityTypes = [
  "item/completed", "turn/plan/updated", "system/interaction/lifecycle",
  "turn/completed", "provider/modelFallback", "system/error",
] as const;

const pageSize = 60;
const displayLimit = 20;

export function useActivity(threadId: string) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const key = storageKey(threadId, "viewed");
  const [seen, setSeen] = useState<number | null>(() => readViewed(key));
  const [rows, setRows] = useState<Activity[]>([]);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (connection !== "connected") return;
    const controller = new AbortController();
    const { signal } = controller;
    let cursor = readViewed(key);
    let displayed: Activity[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;

    function schedule() {
      dirty = true;
      if (running || timer || signal.aborted || displayed.length >= displayLimit) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 150);
    }

    async function refresh() {
      running = true;
      dirty = false;
      try {
        const first = cursor === null;
        const page = await sdk.threads.events.list({
          threadId, signal, types: activityTypes, limit: String(pageSize),
          ...(first ? { order: "desc" } : { order: "asc", afterSeq: String(cursor) }),
        });
        if (signal.aborted) return;
        page.sort((a, b) => a.seq - b.seq);
        const projected = page.flatMap(event => activity(event) ?? []);
        if (first) {
          displayed = projected.slice(-displayLimit);
          const baseline = Math.max(0, (displayed[0]?.seq ?? page.at(-1)?.seq ?? 1) - (displayed.length ? 1 : 0));
          if (readViewed(key) === null) localStorage.setItem(key, String(baseline));
        } else {
          displayed = [...displayed, ...projected.filter(row => cursor === null || row.seq > cursor)]
            .slice(0, displayLimit);
        }
        cursor = page.at(-1)?.seq ?? cursor ?? 0;
        setRows(previous => previous.length === displayed.length &&
          previous.every((row, index) => row.seq === displayed[index]?.seq) ? previous : displayed);
        setError(false);
        setPending(false);
        if (!first && page.length === pageSize) dirty = true;
      } catch {
        if (!signal.aborted) {
          setError(true);
          setPending(false);
        }
      } finally {
        running = false;
        if (dirty) schedule();
      }
    }

    const unsubscribe = sdk.subscribe({
      event: "thread:changed", threadId,
      callback: event => {
        const types = event.metadata?.eventTypes;
        if (!types?.length || types.some(type => activityTypes.some(candidate => candidate === type))) schedule();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      unsubscribe();
      clearTimeout(timer);
    };
  }, [connection, key, revision, sdk, seen, threadId]);

  return {
    rows, pending, error, online: connection === "connected",
    retry: () => setRevision(value => value + 1),
    markViewed: () => {
      const through = viewedThrough(readViewed(key) ?? 0, rows);
      localStorage.setItem(key, String(through));
      setRows([]);
      setSeen(through);
    },
  };
}
