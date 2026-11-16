// The count on the Skills Sync row in the sidebar.
//
// This component is mounted for the whole life of the app window, so it only
// ever reads the cached status (`refresh: false`): checking upstream is
// network work and belongs to a button the user pressed, never to a sidebar
// row. The host clips it to one short line and hides it entirely if it
// throws, so everything here stays defensive and silent on failure.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import { outstandingCount, type Status } from "./model";
import { useSyncSignal } from "./use-sync-signal";

export function SyncSidebarAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState<number | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const current = ++generation.current;
    countOutstanding(rpc).then(
      (next) => {
        if (current === generation.current) setCount(next);
      },
      // A sidebar badge has nowhere to report an error, and a wrong number
      // would be worse than none: drop back to showing nothing.
      () => {
        if (current === generation.current) setCount(null);
      },
    );
  }, [rpc]);

  useEffect(refetch, [refetch]);
  useSyncSignal(refetch);

  if (count === null || count <= 0) return null;
  return (
    <span
      className="truncate text-xs tabular-nums text-muted-foreground"
      aria-label={`${count} ${count === 1 ? "skill" : "skills"} to apply`}
      title={`${count} ${count === 1 ? "skill" : "skills"} to apply`}
    >
      {count}
    </span>
  );
}

/** Outstanding work across every configured source, or null if unreadable. */
async function countOutstanding(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
): Promise<number | null> {
  const { sources } = await rpc.call("listSources", null);
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const counts = await Promise.all(
    sources.map((source) =>
      rpc
        .call("status", { sourceId: source.id, refresh: false })
        .then((status) => safeCount(status), () => null),
    ),
  );
  // One unreadable source must not silently shrink the number, so the whole
  // badge stands down rather than under-reporting.
  if (counts.some((entry) => entry === null)) return null;
  return counts.reduce<number>((total, entry) => total + (entry ?? 0), 0);
}

function safeCount(status: Status): number {
  return Array.isArray(status?.skills) ? outstandingCount(status) : 0;
}
