import { useEffect, useState } from "react";
import { definePluginApp, useComposer, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { SPEED_EVENT_TYPES, SpeedMeter, speedLabel, type Speed, type SpeedEvent } from "../../../core/planning/speed";

const RATIOS_KEY = "plan-progress:tokens-per-char";
const NO_SPEED: Speed = { rate: null, exact: false, live: false };
// the most bb hands out per request
const PAGE = 100;

function loadRatios(): number[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RATIOS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((r): r is number => typeof r === "number") : [];
  } catch {
    return [];
  }
}

function saveRatios(ratios: number[]): void {
  try {
    localStorage.setItem(RATIOS_KEY, JSON.stringify(ratios));
  } catch {
    // private mode or no storage: the ratio is learned again
  }
}

/** The open thread's answer speed, read from its event log as events land. */
function useSpeed(threadId: string | null, enabled: boolean): Speed | null {
  const sdk = useSdk();
  const [speed, setSpeed] = useState<Speed | null>(null);
  useEffect(() => {
    setSpeed(null);
    if (threadId === null || !enabled) return;
    const meter = new SpeedMeter(loadRatios());
    const types = SPEED_EVENT_TYPES as unknown as Parameters<typeof sdk.threads.events.list>[0]["types"];
    const abort = new AbortController();
    let cursor: number | null = null;
    let busy = false;
    let again = false;
    const take = (rows: SpeedEvent[]) => {
      const learned = meter.learned().join();
      for (const row of rows) {
        meter.feed(row);
        cursor = Math.max(cursor ?? 0, row.seq);
      }
      if (meter.learned().join() !== learned) saveRatios(meter.learned());
    };
    // one request at a time; events landing meanwhile ask for one more after it
    const pull = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          if (cursor === null) {
            // the latest stretch of the log: the turn under way and the minute before it
            const rows = (await sdk.threads.events.list({ threadId, types, order: "desc", limit: String(PAGE), signal: abort.signal })) as SpeedEvent[];
            take([...rows].reverse());
            cursor ??= 0;
          } else {
            let rows: SpeedEvent[];
            do {
              rows = (await sdk.threads.events.list({ threadId, types, afterSeq: String(cursor), limit: String(PAGE), signal: abort.signal })) as SpeedEvent[];
              take(rows);
            } while (rows.length === PAGE);
          }
          if (!abort.signal.aborted) setSpeed(meter.speed());
        } while (again && !abort.signal.aborted);
      } catch {
        // a failed read waits for the next events
      } finally {
        busy = false;
      }
    };
    void pull();
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (change) => {
        if (change.changes.includes("events-appended")) void pull();
      },
    });
    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [sdk, threadId, enabled]);
  return speed;
}

/**
 * "⚡ ≈ 42 tok/s" before the voice and send buttons, always there as in the
 * original: bright while the model writes, dimmed with the last figure while a
 * tool runs and between turns, "–" before a second of writing.
 */
function SpeedFigure() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { values } = useSettings();
  const enabled = values?.speed !== false;
  const speed = useSpeed(threadId, enabled) ?? NO_SPEED;
  if (!enabled || threadId === null) return null;
  const isBright = composer.isRunning && speed.live;
  return (
    <span
      className={`self-center whitespace-nowrap px-1 text-xs tabular-nums transition-opacity ${isBright ? "text-foreground" : "text-muted-foreground opacity-70"}`}
      title={
        speed.exact
          ? "Answer speed: the turn's exact output tokens over the time the model spent writing, the latest minute"
          : "Answer speed, estimated: the characters the agent wrote at the tokens per character its exact counts showed, over the latest minute of writing"
      }
      aria-label={speedLabel(speed).replace("⚡ ", "Answer speed ")}
    >
      {speedLabel(speed)}
    </span>
  );
}

export function registerPlanningApp(app: Parameters<Parameters<typeof definePluginApp>[0]>[0]) {
  app.composer.customize({
    id: "plan-progress",
    scopes: ["thread"],
    actions: [{ id: "speed", component: SpeedFigure }],
  });
}
