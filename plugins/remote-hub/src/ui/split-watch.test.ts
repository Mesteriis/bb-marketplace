import { describe, expect, it } from "vitest";
import type { AgentSessionView } from "./agent-panel.tsx";
import { markSessionPage, sessionPageShowing } from "./active-surface.ts";
import { agentThreadOf, autoSplitOnSignal, stillWhereWePutThem, focusedThread, mayAutoSplit, openWatchInSplit, splitShows, type SplitNav } from "./split-watch.ts";

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

  it("C3: the fallback does not navigate when the owner has gone elsewhere during the wait", async () => {
    const { n, calls } = nav();
    const r = await openWatchInSplit({ nav: n, sessionKey: KEY, agentThread: "thr_a", isSplit: () => false, stillHere: () => false, wait: now });
    expect(r.result).toBe("fallback");
    expect(calls).toEqual([`panel:ssh:${KEY}`, "thread:thr_a:split"]);
    const again = nav();
    await openWatchInSplit({ nav: again.n, sessionKey: KEY, agentThread: "thr_a", isSplit: () => false, stillHere: () => true, wait: now });
    expect(again.calls.at(-1)).toBe(`panel:ssh:${KEY}`);
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

describe("D5: the fallback navigates only from a surface it can identify", () => {
  it("the production predicate: agent's thread in focus or the session page showing is 'still here'; everything else is not", () => {
    expect(stillWhereWePutThem({ focused: "thr_a", agentThread: "thr_a", sessionPageShowing: false })).toBe(true);
    expect(stillWhereWePutThem({ focused: null, agentThread: "thr_a", sessionPageShowing: true })).toBe(true);
    // Settings / another plugin panel / no focused thread (focused null, page not showing), or another thread: not here.
    expect(stillWhereWePutThem({ focused: null, agentThread: "thr_a", sessionPageShowing: false })).toBe(false);
    expect(stillWhereWePutThem({ focused: "thr_other", agentThread: "thr_a", sessionPageShowing: false })).toBe(false);
    expect(stillWhereWePutThem({ focused: null, agentThread: null, sessionPageShowing: false })).toBe(false);
  });
  it("the flow with that predicate: no navigation from an unidentified surface, a way back from the identified ones", async () => {
    const off = markSessionPage(KEY);
    expect(sessionPageShowing(KEY)).toBe(true);
    off();
    expect(sessionPageShowing(KEY)).toBe(false);
    const run = async (focused: string | null, pageShowing: boolean) => {
      const { n, calls } = nav();
      await openWatchInSplit({ nav: n, sessionKey: KEY, agentThread: "thr_a", isSplit: () => false, stillHere: () => stillWhereWePutThem({ focused, agentThread: "thr_a", sessionPageShowing: pageShowing }), wait: now });
      return calls;
    };
    expect((await run(null, false)).at(-1)).toBe("thread:thr_a:split");
    expect((await run("thr_a", false)).at(-1)).toBe(`panel:ssh:${KEY}`);
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
