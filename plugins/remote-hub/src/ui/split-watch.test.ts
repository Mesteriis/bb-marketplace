import { describe, expect, it } from "vitest";
import type { AgentSessionView } from "./agent-panel.tsx";
import { agentThreadOf, autoSplitOnSignal, focusedThread, mayAutoSplit, openWatchInSplit, splitShows, type SplitNav } from "./split-watch.ts";

function nav() {
  const calls: string[] = [];
  const n: SplitNav = {
    toPluginPanel: (path, o) => void calls.push(`panel:${path}:${o?.subPath ?? ""}`),
    toThread: (id, o) => void calls.push(`thread:${id}:${o?.split === true ? "split" : "plain"}`),
  };
  return { n, calls };
}
const KEY = "a".repeat(32) + ".4";
const now = async () => {};

describe("openWatchInSplit", () => {
  it("opens the session page first and the agent's thread in a split second", async () => {
    const { n, calls } = nav();
    const r = await openWatchInSplit({ nav: n, sessionKey: KEY, agentThread: "thr_a", isSplit: () => true, wait: now });
    expect(r.result).toBe("split");
    expect(calls).toEqual([`panel:ssh:${KEY}`, "thread:thr_a:split"]);
  });

  it("puts the live view back when BB did not split (plain navigation took the owner to the thread)", async () => {
    const { n, calls } = nav();
    const r = await openWatchInSplit({ nav: n, sessionKey: KEY, agentThread: "thr_a", isSplit: () => false, wait: now });
    expect(r.result).toBe("fallback");
    expect(calls).toEqual([`panel:ssh:${KEY}`, "thread:thr_a:split", `panel:ssh:${KEY}`]);
  });

  it("without a thread it only shows the session page", async () => {
    const { n, calls } = nav();
    const r = await openWatchInSplit({ nav: n, sessionKey: KEY, agentThread: null, isSplit: () => true, wait: now });
    expect(r.result).toBe("no_thread");
    expect(calls).toEqual([`panel:ssh:${KEY}`]);
  });
});

describe("what the layout says", () => {
  const two = { panes: [{ threadId: null, isFocused: false }, { threadId: "thr_a", isFocused: true }] };
  it("splitShows: needs two panes and the agent's thread in one of them", () => {
    expect(splitShows(two, "thr_a")).toBe(true);
    expect(splitShows(two, "thr_b")).toBe(false);
    expect(splitShows({ panes: [{ threadId: "thr_a", isFocused: true }] }, "thr_a")).toBe(false);
    expect(splitShows(null, "thr_a")).toBe(false);
  });
  it("focusedThread: the focused pane wins over the surface's thread", () => {
    expect(focusedThread(two, "thr_z")).toBe("thr_a");
    expect(focusedThread(null, "thr_z")).toBe("thr_z");
    expect(focusedThread({ panes: [{ threadId: null, isFocused: true }] }, "thr_z")).toBeNull();
  });
  it("agentThreadOf: the lease holder, else the opener", () => {
    expect(agentThreadOf({ leaseThreadId: "thr_l", openedByThread: "thr_o" })).toBe("thr_l");
    expect(agentThreadOf({ leaseThreadId: null, openedByThread: "thr_o" })).toBe("thr_o");
    expect(agentThreadOf({ leaseThreadId: null, openedByThread: null })).toBeNull();
  });
});

describe("mayAutoSplit: never navigate when the owner is somewhere else", () => {
  it("only when the focused surface is that agent's thread, and once", () => {
    const done = new Set<string>();
    expect(mayAutoSplit({ focused: "thr_a", agentThread: "thr_a", key: KEY, done })).toBe(true);
    expect(mayAutoSplit({ focused: "thr_b", agentThread: "thr_a", key: KEY, done })).toBe(false);
    expect(mayAutoSplit({ focused: null, agentThread: "thr_a", key: KEY, done })).toBe(false);
    expect(mayAutoSplit({ focused: "thr_a", agentThread: null, key: KEY, done })).toBe(false);
    done.add(KEY);
    expect(mayAutoSplit({ focused: "thr_a", agentThread: "thr_a", key: KEY, done })).toBe(false);
  });
});

describe("autoSplitOnSignal", () => {
  const GEN = "a".repeat(32);
  const session = (over: Partial<AgentSessionView> = {}) =>
    ({ generation: GEN, sessionId: 4, state: "running", openedByThread: "thr_a", leaseThreadId: null, ...over }) as AgentSessionView;
  const run = (focused: string | null, sessions: AgentSessionView[], done = new Set<string>()) => {
    const opened: Array<[string, string | null]> = [];
    return autoSplitOnSignal({
      key: `${GEN}.4`,
      listSessions: async () => sessions,
      layout: () => null,
      contextThread: () => focused,
      done,
      watchInSplit: async (k, t) => void opened.push([k, t]),
    }).then((result) => ({ result, opened, done }));
  };
  it("opens the split when the owner looks at the agent's thread, and only once", async () => {
    const done = new Set<string>();
    expect(await run("thr_a", [session()], done)).toMatchObject({ result: "opened", opened: [[`${GEN}.4`, "thr_a"]] });
    expect((await run("thr_a", [session()], done)).result).toBe("skipped");
  });
  it("does not move the owner's screen when another thread, a page or nothing is in focus", async () => {
    for (const focused of ["thr_other", null]) {
      const r = await run(focused, [session()]);
      expect(r.result, String(focused)).toBe("skipped");
      expect(r.opened).toEqual([]);
    }
  });
  it("skips a closed or unknown session and uses the lease holder over the opener", async () => {
    expect((await run("thr_a", [session({ state: "closed" })])).result).toBe("skipped");
    expect((await run("thr_a", [])).result).toBe("skipped");
    expect(await run("thr_l", [session({ leaseThreadId: "thr_l" })])).toMatchObject({ result: "opened", opened: [[`${GEN}.4`, "thr_l"]] });
  });
});
