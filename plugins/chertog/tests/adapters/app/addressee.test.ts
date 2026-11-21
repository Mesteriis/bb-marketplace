// Who a command for a chosen tile reaches: the composer BB lists for exactly
// the tile's thread, and only when there is one.
import { describe, expect, it } from "vitest";
import { findThreadComposer, runForTileComposer, tileComposer, type ComposerHandle } from "../../../src/adapters/bb/app/addressee.ts";
import { threadAddressee, threadOfAddressee } from "../../../src/adapters/bb/app/thread-source.ts";

interface FakeComposer extends ComposerHandle {
  focused: number;
}

function composer(key: string, scope: ComposerHandle["scope"]): FakeComposer {
  const made: FakeComposer = {
    key,
    scope,
    focused: 0,
    focus() {
      made.focused += 1;
    },
  };
  return made;
}

const threadA = () => composer("c-a", { kind: "thread", threadId: "thr_a" });
const threadB = () => composer("c-b", { kind: "thread", threadId: "thr_b" });
const queuedA = () => composer("c-qa", { kind: "queued-message", threadId: "thr_a" });
const newThread = () => composer("c-new", { kind: "new-thread" });

describe("the composer of a thread", () => {
  it("is unavailable with no match", () => {
    expect(findThreadComposer([], "thr_a")).toEqual({ status: "none" });
    expect(findThreadComposer([threadB(), newThread()], "thr_a")).toEqual({ status: "none" });
  });

  it("is the one composer of that thread's chat", () => {
    const a = threadA();
    expect(findThreadComposer([threadB(), a, newThread()], "thr_a")).toEqual({ status: "one", composer: a });
  });

  it("is unavailable with two matches, and never the first of them", () => {
    const second = composer("c-a2", { kind: "thread", threadId: "thr_a" });
    expect(findThreadComposer([threadA(), second], "thr_a")).toEqual({ status: "several", count: 2 });
  });

  it("does not take the editor of a queued message for the thread's composer", () => {
    expect(findThreadComposer([queuedA()], "thr_a")).toEqual({ status: "none" });
    const a = threadA();
    expect(findThreadComposer([queuedA(), a], "thr_a")).toEqual({ status: "one", composer: a });
  });

  it("matches the whole thread id", () => {
    expect(findThreadComposer([threadA()], "thr_")).toEqual({ status: "none" });
    expect(findThreadComposer([threadA()], "thr_a2")).toEqual({ status: "none" });
  });
});

describe("the addressee of a thread panel", () => {
  it("names the thread and reads back", () => {
    expect(threadAddressee("thr_a")).toBe("thread:thr_a");
    expect(threadOfAddressee("thread:thr_a")).toBe("thr_a");
    expect(threadOfAddressee("chat:42")).toBeNull();
    expect(threadOfAddressee("thread:")).toBeNull();
  });

  it("gives a tile a composer only through its own live addressee", () => {
    const a = threadA();
    const read = (instanceId: string): string | null => (instanceId === "view-1" ? "thread:thr_a" : instanceId === "view-2" ? "chat:42" : null);
    expect(tileComposer(read, [a, threadB()], "view-1")).toEqual({ status: "one", composer: a });
    expect(tileComposer(read, [a], "view-2")).toEqual({ status: "not-a-thread" });
    expect(tileComposer(read, [a], "view-closed")).toEqual({ status: "not-a-thread" });
  });
});

describe("a command for the chosen tile", () => {
  function stage() {
    const state = { addressee: "thread:thr_a" as string | null, composers: [threadA(), threadB()] as FakeComposer[] };
    const run = (work: () => Promise<void> = async () => undefined) =>
      runForTileComposer(
        (instanceId) => (instanceId === "view-1" ? state.addressee : null),
        () => state.composers,
        "view-1",
        work,
        (found) => {
          found.focus();
          return found.key;
        },
      );
    return { state, run };
  }

  it("reaches the composer of the tile's thread", async () => {
    const { state, run } = stage();
    expect(await run()).toEqual({ status: "done", value: "c-a" });
    expect(state.composers.map((item) => item.focused)).toEqual([1, 0]);
  });

  it("does nothing with no composer or with two", async () => {
    const { state, run } = stage();
    state.composers = [threadB()];
    expect(await run()).toEqual({ status: "unavailable", reason: "no-composer" });
    state.composers = [threadA(), composer("c-a2", { kind: "thread", threadId: "thr_a" })];
    expect(await run()).toEqual({ status: "unavailable", reason: "several-composers" });
    expect(state.composers.map((item) => item.focused)).toEqual([0, 0]);
  });

  it("does nothing for a tile that is closed or addresses no thread", async () => {
    const { state, run } = stage();
    state.addressee = null;
    expect(await run()).toEqual({ status: "cancelled", reason: "target-unavailable" });
    state.addressee = "chat:42";
    expect(await run()).toEqual({ status: "unavailable", reason: "not-a-thread" });
    expect(state.composers.map((item) => item.focused)).toEqual([0, 0]);
  });

  it("is cancelled when the tile turns to another thread during the work", async () => {
    const { state, run } = stage();
    const result = await run(async () => {
      state.addressee = "thread:thr_b";
    });
    expect(result).toEqual({ status: "cancelled", reason: "target-changed" });
    expect(state.composers.map((item) => item.focused)).toEqual([0, 0]);
  });

  it("is cancelled when the tile is closed during the work", async () => {
    const { state, run } = stage();
    const result = await run(async () => {
      state.addressee = null;
    });
    expect(result).toEqual({ status: "cancelled", reason: "target-gone" });
  });

  it("does not move to another composer that appeared for the same thread", async () => {
    const { state, run } = stage();
    const replaced = await run(async () => {
      state.composers = [composer("c-a-new", { kind: "thread", threadId: "thr_a" }), threadB()];
    });
    expect(replaced).toEqual({ status: "cancelled", reason: "target-changed" });
    expect(state.composers[0].focused).toBe(0);

    const doubled = await stage().run();
    expect(doubled).toEqual({ status: "done", value: "c-a" });
    const late = stage();
    const second = await late.run(async () => {
      late.state.composers = [...late.state.composers, composer("c-a2", { kind: "thread", threadId: "thr_a" })];
    });
    expect(second).toEqual({ status: "unavailable", reason: "several-composers" });
    expect(late.state.composers.map((item) => item.focused)).toEqual([0, 0, 0]);
  });
});
