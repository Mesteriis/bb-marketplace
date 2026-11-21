import { describe, expect, it } from "vitest";
import { PanelRegistry, runForTarget, type PanelRef, type PanelTarget } from "../../../src/core/panels/index.ts";
import { deferred, FakeClock, FakeProvider, SequentialIds } from "./fakes.ts";

const threadA: PanelRef = { provider: "bb-thread", params: { threadId: "thr_a" } };

async function setup() {
  const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
  const threads = new FakeProvider("bb-thread");
  threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
  registry.registerProvider(threads);
  const opened = registry.open(threadA);
  if (opened.ok) await opened.settled;
  const read = (instanceId: string) => registry.addresseeOf(instanceId);
  return { registry, read };
}

describe("runForTarget", () => {
  it("commits the prepared value to the target captured before the work", async () => {
    const { read } = await setup();
    const prepared: PanelTarget[] = [];
    const committed: Array<[string, PanelTarget]> = [];

    const result = await runForTarget(
      read,
      "panel-1",
      async (target) => {
        prepared.push(target);
        return "upload-7";
      },
      (value, target) => {
        committed.push([value, target]);
        return 3;
      },
    );

    expect(result).toEqual({ status: "done", value: 3 });
    expect(prepared).toEqual([{ instanceId: "panel-1", addressee: "thread:thr_a" }]);
    expect(committed).toEqual([["upload-7", { instanceId: "panel-1", addressee: "thread:thr_a" }]]);
  });

  it("cancels when the target is closed during the work", async () => {
    const { registry, read } = await setup();
    const work = deferred<string>();
    let commits = 0;

    const result = runForTarget(read, "panel-1", () => work.promise, () => (commits += 1));
    await registry.close("panel-1");
    work.resolve("upload-7");

    expect(await result).toEqual({ status: "cancelled", reason: "target-gone" });
    expect(commits).toBe(0);
  });

  it("cancels when the panel now addresses someone else", async () => {
    const { registry, read } = await setup();
    const work = deferred<string>();
    let commits = 0;

    const result = runForTarget(read, "panel-1", () => work.promise, () => (commits += 1));
    registry.setAddressee("panel-1", "thread:thr_b");
    work.resolve("upload-7");

    expect(await result).toEqual({ status: "cancelled", reason: "target-changed" });
    expect(commits).toBe(0);
  });

  it("cancels when the same reference was closed and opened again as another instance", async () => {
    const { registry, read } = await setup();
    const work = deferred<string>();
    let commits = 0;

    const result = runForTarget(read, "panel-1", () => work.promise, () => (commits += 1));
    await registry.close("panel-1");
    const reopened = registry.open(threadA);
    if (reopened.ok) await reopened.settled;
    work.resolve("upload-7");

    expect(registry.addresseeOf("panel-2")).toBe("thread:thr_a");
    expect(await result).toEqual({ status: "cancelled", reason: "target-gone" });
    expect(commits).toBe(0);
  });

  it("commits when the addressee changed and came back before the check", async () => {
    const { registry, read } = await setup();
    const work = deferred<string>();
    let commits = 0;

    const result = runForTarget(read, "panel-1", () => work.promise, () => (commits += 1));
    registry.setAddressee("panel-1", "thread:thr_b");
    registry.setAddressee("panel-1", "thread:thr_a");
    work.resolve("upload-7");

    expect(await result).toEqual({ status: "done", value: 1 });
    expect(commits).toBe(1);
  });

  it("does not start the work for a panel without an addressee", async () => {
    const { registry, read } = await setup();
    registry.setAddressee("panel-1", null);
    let prepares = 0;
    let commits = 0;

    const result = await runForTarget(
      read,
      "panel-1",
      async () => (prepares += 1),
      () => (commits += 1),
    );

    expect(result).toEqual({ status: "cancelled", reason: "target-unavailable" });
    expect([prepares, commits]).toEqual([0, 0]);
  });

  it("does not start the work for an instance that is not open", async () => {
    const { read } = await setup();
    let prepares = 0;

    const result = await runForTarget(read, "panel-9", async () => (prepares += 1), () => undefined);

    expect(result).toEqual({ status: "cancelled", reason: "target-unavailable" });
    expect(prepares).toBe(0);
  });

  it("passes on a failure of the work without committing", async () => {
    const { read } = await setup();
    let commits = 0;

    const result = runForTarget(
      read,
      "panel-1",
      async () => {
        throw new Error("upload failed");
      },
      () => (commits += 1),
    );

    await expect(result).rejects.toThrow("upload failed");
    expect(commits).toBe(0);
  });
});
