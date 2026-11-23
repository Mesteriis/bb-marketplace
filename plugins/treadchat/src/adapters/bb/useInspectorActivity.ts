import { useEffect, useState } from "react";
import { useRealtimeConnectionState, useSdk } from "@get-bb/plugin-sdk/app";
import { activity, type Activity } from "../../core/activity";
import { inspectorActivity } from "../../core/inspector";

const recentEvents = 60;

export function useInspectorActivity(threadId: string) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const [data, setData] = useState(() => inspectorActivity([]));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (connection !== "connected") return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let dirty = false;
    let cursor: number | undefined;
    let items: Activity[] = [];

    async function refresh() {
      busy = true;
      dirty = false;
      try {
        const rows = await sdk.threads.events.list({
          threadId, types: ["item/completed"], limit: String(recentEvents), signal,
          ...(cursor === undefined ? { order: "desc" } : { order: "asc", afterSeq: String(cursor) }),
        });
        if (!signal.aborted) {
          const initial = cursor === undefined;
          const catchingUp = !initial && rows.length === recentEvents;
          for (const row of rows) cursor = Math.max(cursor ?? 0, row.seq);
          const projected = rows.flatMap(row => activity(row) ?? [])
            .filter(row => row.kind === "agent" || row.kind === "check" || row.paths?.length);
          if (initial || projected.length) {
            items = [...projected, ...items].sort((a, b) => b.seq - a.seq).slice(0, recentEvents);
            setData(inspectorActivity(items));
          }
          if (catchingUp) dirty = true;
          setFailed(false);
        }
      } catch {
        if (!signal.aborted) setFailed(true);
      } finally {
        busy = false;
        if (dirty) schedule();
      }
    }

    function schedule() {
      dirty = true;
      if (timer || busy || signal.aborted) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 250);
    }

    const unsubscribe = sdk.subscribe({
      event: "thread:changed", threadId,
      callback: event => {
        const types = event.metadata?.eventTypes;
        if (!types?.length || types.includes("item/completed")) schedule();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      unsubscribe();
      clearTimeout(timer);
    };
  }, [connection, sdk, threadId]);

  return { ...data, stale: connection !== "connected" || failed };
}
