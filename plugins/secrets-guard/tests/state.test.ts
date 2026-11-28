import { describe, expect, it } from "vitest";
import {
  close,
  effective,
  openGlobal,
  openThreads,
  parseState,
  prune,
  resyncTree,
  treeRoots,
  type GuardState,
} from "../src/core/state.ts";

const empty: GuardState = { threads: {} };

const tree: GuardState = {
  threads: {
    a: { until: 1600, root: "a", tree: true },
    b: { until: 1600, root: "a", tree: true },
    c: { until: 1600, root: "a", tree: true },
    x: { until: 2800, root: "x", tree: false },
  },
};

describe("openGlobal", () => {
  it("sets the global deadline 10 minutes ahead", () => {
    expect(openGlobal(empty, 1000, 10)).toEqual({ until: 1600, threads: {} });
  });
  it("sets 30 and 60 minutes", () => {
    expect(openGlobal(empty, 1000, 30).until).toBe(2800);
    expect(openGlobal(empty, 1000, 60).until).toBe(4600);
  });
  it("keeps thread entries", () => {
    expect(openGlobal(tree, 1000, 10).threads).toEqual(tree.threads);
  });
});

describe("openThreads", () => {
  it("opens one thread when descendants are null", () => {
    expect(openThreads(empty, 1000, 30, "a", null)).toEqual({
      threads: { a: { until: 2800, root: "a", tree: false } },
    });
  });
  it("opens the root and its descendants", () => {
    expect(openThreads(empty, 1000, 10, "a", ["b", "c"])).toEqual({
      threads: {
        a: { until: 1600, root: "a", tree: true },
        b: { until: 1600, root: "a", tree: true },
        c: { until: 1600, root: "a", tree: true },
      },
    });
  });
  it("reopening the same root replaces the deadline of all its entries", () => {
    const first = openThreads(empty, 1000, 10, "a", ["b", "c"]);
    expect(openThreads(first, 1000, 60, "a", ["b", "c"])).toEqual({
      threads: {
        a: { until: 4600, root: "a", tree: true },
        b: { until: 4600, root: "a", tree: true },
        c: { until: 4600, root: "a", tree: true },
      },
    });
  });
  it("reopening as a single thread drops the former descendants", () => {
    const first = openThreads(empty, 1000, 10, "a", ["b"]);
    expect(openThreads(first, 1000, 30, "a", null)).toEqual({
      threads: { a: { until: 2800, root: "a", tree: false } },
    });
  });
  it("does not shorten a descendant's later deadline from another root", () => {
    const state: GuardState = { threads: { b: { until: 4600, root: "b", tree: false } } };
    expect(openThreads(state, 1000, 10, "a", ["b"]).threads.b).toEqual({
      until: 4600,
      root: "b",
      tree: false,
    });
  });
  it("keeps the global deadline", () => {
    expect(openThreads({ until: 1500, threads: {} }, 1000, 10, "a", null).until).toBe(1500);
  });
});

describe("prune", () => {
  it("drops an entry whose deadline is not in the future and keeps a later one", () => {
    const state: GuardState = {
      threads: {
        a: { until: 1000, root: "a", tree: false },
        b: { until: 1001, root: "b", tree: false },
      },
    };
    expect(prune(state, 1000)).toEqual({ threads: { b: { until: 1001, root: "b", tree: false } } });
  });
  it("drops a past global deadline", () => {
    expect(prune({ until: 999, threads: {} }, 1000)).toEqual({ threads: {} });
  });
  it("keeps a future global deadline", () => {
    expect(prune({ until: 1001, threads: {} }, 1000)).toEqual({ until: 1001, threads: {} });
  });
});

describe("effective", () => {
  it("is null with no entries", () => {
    expect(effective(empty, 1000, "a")).toBeNull();
  });
  it("reports a thread entry", () => {
    const state: GuardState = { threads: { a: { until: 2800, root: "a", tree: false } } };
    expect(effective(state, 1000, "a")).toEqual({ scope: "thread", until: 2800, rootThreadId: "a" });
  });
  it("reports a tree for a descendant", () => {
    expect(effective(tree, 1000, "b")).toEqual({ scope: "tree", until: 1600, rootThreadId: "a" });
  });
  it("is null for a thread that is not in the state", () => {
    expect(effective(tree, 1000, "zzz")).toBeNull();
  });
  it("is null for an expired entry", () => {
    expect(effective(tree, 1600, "a")).toBeNull();
  });
  it("prefers the thread entry when it expires later than the global deadline", () => {
    const state: GuardState = { until: 1600, threads: { a: { until: 2800, root: "a", tree: false } } };
    expect(effective(state, 1000, "a")).toEqual({ scope: "thread", until: 2800, rootThreadId: "a" });
  });
  it("prefers the global deadline when it expires later", () => {
    const state: GuardState = { until: 4600, threads: { a: { until: 2800, root: "a", tree: false } } };
    expect(effective(state, 1000, "a")).toEqual({ scope: "global", until: 4600, rootThreadId: null });
  });
  it("reports the global deadline for a thread without an entry", () => {
    expect(effective({ until: 1600, threads: {} }, 1000, "zzz")).toEqual({
      scope: "global",
      until: 1600,
      rootThreadId: null,
    });
  });
  it("ignores an expired global deadline", () => {
    expect(effective({ until: 1000, threads: {} }, 1000, "a")).toBeNull();
  });
});

describe("close", () => {
  it("removes only the global deadline when the global one is in effect", () => {
    const state: GuardState = { until: 4600, threads: { a: { until: 2800, root: "a", tree: false } } };
    expect(close(state, 1000, "a")).toEqual({
      threads: { a: { until: 2800, root: "a", tree: false } },
    });
  });
  it("removes only the thread entry when it outlasts the global deadline", () => {
    const state: GuardState = { until: 1600, threads: { a: { until: 2800, root: "a", tree: false } } };
    expect(close(state, 1000, "a")).toEqual({ until: 1600, threads: {} });
  });
  it("removes the whole tree when called from a descendant", () => {
    expect(close(tree, 1000, "b")).toEqual({
      threads: { x: { until: 2800, root: "x", tree: false } },
    });
  });
  it("removes one thread entry and leaves other roots", () => {
    expect(close(tree, 1000, "x").threads).toEqual({
      a: { until: 1600, root: "a", tree: true },
      b: { until: 1600, root: "a", tree: true },
      c: { until: 1600, root: "a", tree: true },
    });
  });
  it("changes nothing when nothing is open for the thread", () => {
    expect(close(tree, 1000, "zzz")).toEqual(tree);
  });
});

describe("treeRoots", () => {
  it("lists roots opened with subthreads and a future deadline", () => {
    expect(treeRoots(tree, 1000)).toEqual(["a"]);
  });
  it("skips expired roots", () => {
    expect(treeRoots(tree, 1600)).toEqual([]);
  });
});

describe("resyncTree", () => {
  it("drops a thread that left the tree and adds a new descendant", () => {
    expect(resyncTree(tree, 1000, "a", ["b", "d"])).toEqual({
      threads: {
        a: { until: 1600, root: "a", tree: true },
        b: { until: 1600, root: "a", tree: true },
        d: { until: 1600, root: "a", tree: true },
        x: { until: 2800, root: "x", tree: false },
      },
    });
  });
  it("returns the same state when the tree has not changed", () => {
    expect(resyncTree(tree, 1000, "a", ["c", "b"])).toBe(tree);
  });
  it("changes nothing when the root has expired", () => {
    expect(resyncTree(tree, 1600, "a", ["b", "d"])).toEqual(tree);
  });
  it("changes nothing for a root opened without subthreads", () => {
    expect(resyncTree(tree, 1000, "x", ["y"])).toEqual(tree);
  });
  it("does not take over a descendant whose own deadline is later", () => {
    expect(resyncTree(tree, 1000, "a", ["b", "c", "x"]).threads.x).toEqual({
      until: 2800,
      root: "x",
      tree: false,
    });
  });
});

describe("parseState", () => {
  it.each([[null], ["x"], [5], [[]], [{ threads: [] }], [{ threads: { a: 5 } }], [{ threads: { a: { until: "soon" } } }]])(
    "reads %j as closed",
    (raw) => {
      expect(parseState(raw)).toEqual({ threads: {} });
    },
  );
  it("reads the old format", () => {
    expect(parseState({ until: 5 })).toEqual({ until: 5, threads: {} });
  });
  it("drops a non-numeric global deadline", () => {
    expect(parseState({ until: "5" })).toEqual({ threads: {} });
  });
  it("keeps valid entries and drops broken ones", () => {
    expect(
      parseState({
        threads: {
          a: { until: 9, root: "a", tree: true },
          b: { until: 9, root: 1, tree: true },
          c: { until: 9, root: "a" },
          d: { until: Number.POSITIVE_INFINITY, root: "d", tree: false },
        },
      }),
    ).toEqual({ threads: { a: { until: 9, root: "a", tree: true } } });
  });
});
