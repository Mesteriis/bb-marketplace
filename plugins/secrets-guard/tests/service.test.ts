import { describe, expect, it } from "vitest";
import { NotLocal, StoreUnavailable, type LogEvent, type StateStore } from "../src/core/ports.ts";
import { createService } from "../src/core/service.ts";
import type { GuardState } from "../src/core/state.ts";

/** A store in memory with the file store's contract: an unchanged state writes and logs nothing. */
function memoryStore(initial: GuardState = { threads: {} }, configured = true, writable = true) {
  const memory = { state: initial, logs: [] as LogEvent[], writes: 0 };
  const store: StateStore = {
    async writable() {
      return configured && writable;
    },
    async read() {
      return memory.state;
    },
    async update(change, log) {
      if (!configured) throw new StoreUnavailable("not_configured");
      const before = memory.state;
      const next = change(before);
      if (next === before) return before;
      memory.state = next;
      memory.writes += 1;
      memory.logs.push(typeof log === "function" ? log(before) : log);
      return next;
    },
  };
  return { store, memory };
}

function setup(
  options: { initial?: GuardState; configured?: boolean; writable?: boolean; remote?: string[] } = {},
) {
  const tree: Record<string, string[]> = { a: ["b"] };
  const clock = { now: 1000 };
  const listing = { calls: 0, onCall: (_call: number) => {}, fail: false };
  const { store, memory } = memoryStore(options.initial, options.configured, options.writable);
  const service = createService({
    store,
    threads: {
      children: async (id) => {
        listing.calls += 1;
        listing.onCall(listing.calls);
        if (listing.fail) throw new Error("server is busy");
        return tree[id] ?? [];
      },
      isLocal: async (id) => !(options.remote ?? []).includes(id),
    },
    now: () => clock.now,
  });
  return { service, memory, tree, clock, listing };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NotLocal) return "forbidden";
    if (error instanceof StoreUnavailable) return error.reason;
    throw error;
  }
  return "resolved";
}

describe("open", () => {
  it("opens a thread with its subthreads", async () => {
    const { service, memory } = setup();
    const view = await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    expect(memory.state).toEqual({
      threads: {
        a: { until: 1600, root: "a", tree: true },
        b: { until: 1600, root: "a", tree: true },
      },
    });
    expect(view).toEqual({
      configured: true,
      local: true,
      effective: { scope: "tree", until: 1600, rootThreadId: "a" },
    });
    expect(memory.logs).toEqual([{ event: "open", scope: "tree", root: "a", until: 1600 }]);
  });
  it("opens one thread and leaves its subthreads closed", async () => {
    const { service, memory } = setup();
    await service.open({ threadId: "a", scope: "thread", minutes: 30 });
    expect(memory.state).toEqual({ threads: { a: { until: 2800, root: "a", tree: false } } });
    expect(memory.logs).toEqual([{ event: "open", scope: "thread", root: "a", until: 2800 }]);
  });
  it("opens globally", async () => {
    const { service, memory } = setup();
    const view = await service.open({ threadId: "a", scope: "global", minutes: 60 });
    expect(memory.state).toEqual({ until: 4600, threads: {} });
    expect(view.effective).toEqual({ scope: "global", until: 4600, rootThreadId: null });
    expect(memory.logs).toEqual([{ event: "open", scope: "global", root: null, until: 4600 }]);
  });
  it("refuses a thread that runs on another machine", async () => {
    const { service, memory } = setup({ remote: ["a"] });
    expect(await refusal(service.open({ threadId: "a", scope: "global", minutes: 10 }))).toBe("forbidden");
    expect(memory.state).toEqual({ threads: {} });
    expect(memory.writes).toBe(0);
  });
  it("does not open a subthread that left the tree while it was being opened", async () => {
    const { service, memory, tree, listing } = setup();
    // The first walk (root, then b) still sees b; it moves away before the marker is written.
    listing.onCall = (call) => {
      if (call === 2) tree.a = [];
    };
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    expect(memory.state).toEqual({ threads: { a: { until: 1600, root: "a", tree: true } } });
  });
  it("opens nothing when the subthreads cannot be listed", async () => {
    const { service, memory, listing } = setup();
    listing.fail = true;
    await expect(service.open({ threadId: "a", scope: "tree", minutes: 10 })).rejects.toThrow("server is busy");
    expect(memory.state).toEqual({ threads: {} });
  });
  it("refuses when the marker location is not set", async () => {
    const { service } = setup({ configured: false });
    expect(await refusal(service.open({ threadId: "a", scope: "thread", minutes: 10 }))).toBe("not_configured");
  });
});

describe("state", () => {
  it("reports a thread on another machine as not local and closed", async () => {
    const { service } = setup({ remote: ["a"], initial: { until: 4600, threads: {} } });
    expect(await service.state({ threadId: "a" })).toEqual({ configured: true, local: false, effective: null });
  });
  it("reports a missing marker location", async () => {
    const { service } = setup({ configured: false });
    expect(await service.state({ threadId: "a" })).toEqual({ configured: false, local: true, effective: null });
  });
  it("reports a location that cannot be written as not configured", async () => {
    const { service } = setup({ writable: false, initial: { until: 4600, threads: {} } });
    expect(await service.state({ threadId: "a" })).toEqual({ configured: false, local: true, effective: null });
  });
  it("shows a global opening in any thread", async () => {
    const { service } = setup({ initial: { until: 1600, threads: {} } });
    expect(await service.state({ threadId: "zzz" })).toEqual({
      configured: true,
      local: true,
      effective: { scope: "global", until: 1600, rootThreadId: null },
    });
  });
  it("reports closed after the deadline", async () => {
    const { service, clock } = setup({ initial: { until: 1600, threads: {} } });
    clock.now = 1600;
    expect((await service.state({ threadId: "a" })).effective).toBeNull();
  });
});

describe("close", () => {
  it("closes the tree from a subthread and logs it", async () => {
    const { service, memory } = setup();
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    const view = await service.close({ threadId: "b" });
    expect(memory.state).toEqual({ threads: {} });
    expect(view.effective).toBeNull();
    expect(memory.logs[1]).toEqual({ event: "close", scope: "tree", root: "a", until: null });
  });
  it("closes only the later global opening and shows the thread's own one", async () => {
    const { service, memory } = setup({
      initial: { until: 4600, threads: { a: { until: 2800, root: "a", tree: false } } },
    });
    const view = await service.close({ threadId: "a" });
    expect(memory.state).toEqual({ threads: { a: { until: 2800, root: "a", tree: false } } });
    expect(view.effective).toEqual({ scope: "thread", until: 2800, rootThreadId: "a" });
    expect(memory.logs).toEqual([{ event: "close", scope: "global", root: null, until: null }]);
  });
  it("writes nothing when nothing is open", async () => {
    const { service, memory } = setup();
    await service.close({ threadId: "a" });
    expect(memory.writes).toBe(0);
    expect(memory.logs).toEqual([]);
  });
  it("refuses a thread that runs on another machine", async () => {
    const { service } = setup({ remote: ["a"], initial: { until: 4600, threads: {} } });
    expect(await refusal(service.close({ threadId: "a" }))).toBe("forbidden");
  });
});

describe("resync", () => {
  it("opens a subthread created after the button was pressed", async () => {
    const { service, memory, tree } = setup();
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    tree.a = ["b", "c"];
    await service.resync();
    expect(memory.state.threads.c).toEqual({ until: 1600, root: "a", tree: true });
    expect(memory.logs[1]).toEqual({ event: "resync", scope: "tree", root: "a", until: 1600 });
  });
  it("closes a thread that left the tree", async () => {
    const { service, memory, tree } = setup();
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    tree.a = [];
    await service.resync();
    expect(memory.state).toEqual({ threads: { a: { until: 1600, root: "a", tree: true } } });
  });
  it("writes and logs nothing when the tree has not changed", async () => {
    const { service, memory } = setup();
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    await service.resync();
    expect(memory.writes).toBe(1);
    expect(memory.logs).toHaveLength(1);
  });
  it("writes and logs nothing after the deadline", async () => {
    const { service, memory, tree, clock } = setup();
    await service.open({ threadId: "a", scope: "tree", minutes: 10 });
    tree.a = ["b", "c"];
    clock.now = 1601;
    await service.resync();
    expect(memory.state).toEqual({
      threads: {
        a: { until: 1600, root: "a", tree: true },
        b: { until: 1600, root: "a", tree: true },
      },
    });
    expect(memory.writes).toBe(1);
    expect(memory.logs).toHaveLength(1);
  });
  it("closes the subthreads and reports the failure when the tree cannot be listed", async () => {
    const { service, memory, listing } = setup({
      initial: {
        threads: {
          a: { until: 1600, root: "a", tree: true },
          b: { until: 1600, root: "a", tree: true },
          x: { until: 2800, root: "x", tree: false },
        },
      },
    });
    listing.fail = true;
    await expect(service.resync()).rejects.toThrow("1");
    expect(memory.state).toEqual({
      threads: {
        a: { until: 1600, root: "a", tree: true },
        x: { until: 2800, root: "x", tree: false },
      },
    });
  });
  it("leaves a thread opened without subthreads alone", async () => {
    const { service, memory } = setup();
    await service.open({ threadId: "a", scope: "thread", minutes: 10 });
    await service.resync();
    expect(memory.state).toEqual({ threads: { a: { until: 1600, root: "a", tree: false } } });
    expect(memory.writes).toBe(1);
  });
  it("does nothing when the marker location is not set", async () => {
    const { service, memory } = setup({ configured: false });
    await service.resync();
    expect(memory.writes).toBe(0);
  });
});
