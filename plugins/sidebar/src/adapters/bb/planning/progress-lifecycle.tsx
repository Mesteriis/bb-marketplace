import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { BARS_CHANGED, type Bar, type BarState } from "../../../core/planning/engine";
import { AGENTS_CHANGED, type Agent } from "../../../core/planning/agents";
import { dueToHide } from "../../../core/planning/presentation";

const NO_BARS: Bar[] = [];

/** The thread's bars, kept current by the server's realtime signal. */
function useBars(threadId: string | null): Bar[] {
  const rpc = useRpc<typeof rpcContract>();
  // the bars remember their thread, so a render right after a switch never shows (or auto-closes) another thread's
  const [loaded, setLoaded] = useState<{ threadId: string; bars: Bar[] } | null>(null);
  const bars = loaded !== null && loaded.threadId === threadId ? loaded.bars : NO_BARS;
  const setBars = useCallback(
    (next: Bar[]) => {
      if (threadId !== null) setLoaded({ threadId, bars: next });
    },
    [threadId],
  );
  // only the latest request may land: an older answer, or one for the thread shown before, is dropped
  const latest = useRef(0);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    const ticket = ++latest.current;
    rpc.call("bars_get", { threadId }).then(
      (result) => {
        if (ticket === latest.current) setBars(result.bars);
      },
      () => undefined,
    );
  }, [rpc, threadId, setBars]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(BARS_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refetch();
  });
  return bars;
}

/** The subagents of the thread's latest turn, pushed by the server as they change. */
function useAgents(threadId: string | null): Agent[] {
  const rpc = useRpc<typeof rpcContract>();
  const [loaded, setLoaded] = useState<{threadId: string; agents: Agent[]} | null>(null);
  const agents = loaded?.threadId === threadId ? loaded.agents : [];
  const agentVersion = useRef(0);
  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    const ticket = ++agentVersion.current;
    rpc.call("agents_get", { threadId }).then(
      (result) => live && ticket === agentVersion.current && setLoaded({ threadId, agents: result.agents }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId]);
  useRealtime(AGENTS_CHANGED, (payload) => {
    const update = payload as { threadId?: unknown; agents?: unknown } | null;
    if (update?.threadId === threadId && Array.isArray(update.agents)) { agentVersion.current++; if (threadId) setLoaded({ threadId, agents: update.agents as Agent[] }); }
  });
  return agents;
}

/** Ticks once a second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function chime(state: BarState): void {
  const notes: Partial<Record<BarState, number[]>> = {
    needs_input: [660, 880],
    error: [440, 330],
    done: [523, 659, 784],
  };
  const tones = notes[state];
  if (tones === undefined) return;
  try {
    const audio = new AudioContext();
    void audio.resume();
    tones.forEach((frequency, index) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + index * 0.12;
      osc.frequency.value = frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
    setTimeout(() => void audio.close(), 1500);
  } catch {
    // no audio in this browser
  }
}

/** Keep completion timers and chimes for the selected thread in the sidebar. */
export function ProgressLifecycle({ threadId }: { threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const autoClose = values?.autoClose !== false;
  const autoCloseSeconds = Number(values?.autoCloseSeconds ?? 30) || 30;
  const sounds = values?.sounds === true;
  const bars = useBars(threadId);
  const agents = useAgents(threadId);
  const now = useNow(autoClose && bars.some(bar => bar.state === "done" && bar.hidden === undefined));
  const hasRunningAgents = agents.some(agent => agent.state === "running");
  const setVisibility = useCallback(async (id: string, endedAt?: number) => {
    if (threadId === null) return false;
    try {
      await rpc.call("bars_setVisibility", { threadId, id, hidden: true, ...(endedAt === undefined ? {} : { endedAt }) });
      return true;
    } catch {
      return false; // The timer retries on the next tick.
    }
  }, [rpc, threadId]);

  // One successful request per finish, even before the realtime refetch arrives.
  // A failed request may be retried on the next tick.
  const hiding = useRef(new Set<string>());
  useEffect(() => {
    if (!autoClose) return;
    const finishes = new Set(bars.map(bar => `${threadId}:${bar.id}:${bar.endedAt}`));
    for (const key of hiding.current) if (!finishes.has(key)) hiding.current.delete(key);
    for (const bar of bars) {
      if (!dueToHide(bar, now, autoCloseSeconds, hasRunningAgents)) continue;
      const key = `${threadId}:${bar.id}:${bar.endedAt}`;
      if (hiding.current.has(key)) continue;
      hiding.current.add(key);
      void setVisibility(bar.id, bar.endedAt).then(ok => { if (!ok) hiding.current.delete(key); });
    }
  }, [bars, now, threadId, autoClose, autoCloseSeconds, hasRunningAgents, setVisibility]);

  const seen = useRef<Map<string, BarState> | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Map(bars.map(bar => [`${threadId}:${bar.id}:${bar.createdAt}`, bar.state]));
    if (previous === null || !sounds) return;
    const changed = bars.find(bar => {
      const was = previous.get(`${threadId}:${bar.id}:${bar.createdAt}`);
      return was !== undefined && was !== bar.state;
    });
    if (changed !== undefined) chime(changed.state);
  }, [bars, sounds, threadId]);

  return null;
}
