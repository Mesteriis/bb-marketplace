import { describe, expect, it } from "vitest";
import { createDeskStore } from "./desk-store.ts";
import type { DeskSession } from "../core/desk.ts";

const session: DeskSession = { id: "a", kind: "pve-terminal", title: "rdp-ssh-test", detail: "LXC 165", target: { type: "pve", profileId: "p", console: "lxc", vmid: 165 }, state: "connecting", owner: "human", attempt: 0, reason: null };

describe("desk store", () => {
  it("starts empty and tells subscribers about every change", () => {
    const store = createDeskStore();
    const seen: number[] = [];
    const stop = store.subscribe(() => seen.push(store.get().sessions.length));
    expect(store.get().sessions).toEqual([]);
    store.open(session);
    store.patch("a", { state: "active" });
    expect(seen).toEqual([1, 1]);
    expect(store.get().sessions[0]?.state).toBe("active");
    stop();
    store.close("a");
    expect(seen).toEqual([1, 1]);
    expect(store.get().sessions).toEqual([]);
  });

  it("does not notify when nothing changed, and keeps the same snapshot object", () => {
    const store = createDeskStore();
    store.open(session);
    const before = store.get();
    let calls = 0;
    store.subscribe(() => calls++);
    store.focus("a");
    store.close("missing");
    store.layout("one");
    expect(calls).toBe(0);
    expect(store.get()).toBe(before);
  });
});
