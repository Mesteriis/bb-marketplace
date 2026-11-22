import { describe, expect, it, vi } from "vitest";
import { ThreadDirectory, type ThreadDirectoryState } from "../../../src/adapters/bb/app/thread-source.ts";

const ready = (): ThreadDirectoryState => ({
  status: "ready",
  threads: [
    { id: "thr_a", title: "Исполнитель", projectName: "bb-main" },
    { id: "thr_b", title: "Ревьюер", projectName: "bb-main", parentThreadId: "thr_a", status: { tone: "busy", label: "Работает" } },
  ],
});

describe("ThreadDirectory.set", () => {
  it("does not notify when the same content arrives again", () => {
    const directory = new ThreadDirectory();
    directory.set(ready());
    const listener = vi.fn();
    directory.subscribe(listener);

    directory.set(ready());

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when a title, a status or the list changes", () => {
    const directory = new ThreadDirectory();
    directory.set(ready());
    const listener = vi.fn();
    directory.subscribe(listener);
    const changed = ready() as Extract<ThreadDirectoryState, { status: "ready" }>;

    directory.set({ status: "ready", threads: [{ ...changed.threads[0], title: "Другое" }, changed.threads[1]] });
    directory.set({ status: "ready", threads: [changed.threads[0], { ...changed.threads[1], status: { tone: "busy", label: "Ждёт" } }] });
    directory.set({ status: "ready", threads: [changed.threads[0]] });
    directory.set({ status: "error" });

    expect(listener).toHaveBeenCalledTimes(4);
  });
});
