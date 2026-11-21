import { describe, expect, it } from "vitest";
import { PanelRegistry, type PanelInstance, type PanelOpenOutcome, type PanelRef } from "../../../src/core/panels/index.ts";
import { deferred, FakeClock, FakeProvider, SequentialIds } from "./fakes.ts";

const threadA: PanelRef = { provider: "bb-thread", params: { threadId: "thr_a" } };
const threadB: PanelRef = { provider: "bb-thread", params: { threadId: "thr_b" } };
const call: PanelRef = { provider: "zoom", params: { meeting: "standup" } };

function setup() {
  const clock = new FakeClock(1000);
  const registry = new PanelRegistry({ clock, ids: new SequentialIds() });
  const threads = new FakeProvider("bb-thread");
  registry.registerProvider(threads);
  return { clock, registry, threads };
}

/** Opens a reference and waits for the provider's answer. */
async function openSettled(registry: PanelRegistry, ref: PanelRef, newView = false): Promise<PanelInstance> {
  const opened = registry.open(ref, { newView });
  if (!opened.ok) throw new Error("open refused: " + opened.reason);
  const instance = await opened.settled;
  if (instance === null) throw new Error("closed before the provider answered");
  return instance;
}

describe("opening", () => {
  it("returns a loading instance at once and turns it live when the provider answers", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });

    const opened = registry.open(threadA);

    expect(opened).toMatchObject({
      ok: true,
      instance: {
        instanceId: "panel-1",
        ref: { provider: "bb-thread", params: { threadId: "thr_a" } },
        state: "loading",
        placed: true,
        addressee: null,
        unknownOutcome: null,
        openedAt: 1000,
        hiddenAt: null,
      },
    });
    if (!opened.ok) return;
    expect(await opened.settled).toMatchObject({ instanceId: "panel-1", state: "live", addressee: "thread:thr_a" });
    expect(registry.get("panel-1")).toMatchObject({ state: "live", addressee: "thread:thr_a" });
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("returns the same instance for the same reference and opens the provider once", async () => {
    const { registry, threads } = setup();
    const first = await openSettled(registry, threadA);
    const second = await openSettled(registry, { provider: "bb-thread", params: { threadId: "thr_a" } });

    expect(first.instanceId).toBe("panel-1");
    expect(second.instanceId).toBe("panel-1");
    expect(threads.opens).toEqual(["panel-1"]);
    expect(registry.list()).toHaveLength(1);
  });

  it("does not open the provider twice while the first open is still loading", async () => {
    const { registry, threads } = setup();
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;

    const first = registry.open(threadA);
    const second = registry.open(threadA);

    expect(first.ok && first.instance.instanceId).toBe("panel-1");
    expect(second.ok && second.instance.instanceId).toBe("panel-1");
    expect(threads.opens).toEqual(["panel-1"]);
    pending.resolve({ status: "live", addressee: null });
    if (second.ok) expect((await second.settled)?.state).toBe("live");
  });

  it("gives different references different instances", async () => {
    const { registry, threads } = setup();
    const a = await openSettled(registry, threadA);
    const b = await openSettled(registry, threadB);

    expect([a.instanceId, b.instanceId]).toEqual(["panel-1", "panel-2"]);
    expect(threads.opens).toEqual(["panel-1", "panel-2"]);
  });

  it("opens a second view only when the provider declares several views", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;

    const first = await openSettled(registry, threadA);
    const second = await openSettled(registry, threadA, true);
    const reused = await openSettled(registry, threadA);

    expect([first.instanceId, second.instanceId]).toEqual(["panel-1", "panel-2"]);
    expect(reused.instanceId).toBe("panel-1");
    expect(threads.opens).toEqual(["panel-1", "panel-2"]);
  });

  it("refuses a second view when the provider has a single view", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);

    expect(registry.open(threadA, { newView: true })).toEqual({ ok: false, reason: "multiple-views-unsupported" });
    expect(threads.opens).toEqual(["panel-1"]);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses a reference that carries a secret and opens nothing", () => {
    const { registry, threads } = setup();
    const unsafe = { provider: "bb-thread", params: { token: "abc" } };

    expect(registry.open(unsafe)).toEqual({ ok: false, reason: "invalid-ref" });
    expect(threads.opens).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("refuses a parameter the provider does not declare and opens nothing", () => {
    const { registry, threads } = setup();
    const extra = { provider: "bb-thread", params: { threadId: "thr_a", note: "hello" } };

    expect(registry.open(extra)).toEqual({ ok: false, reason: "invalid-ref" });
    expect(threads.opens).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("refuses a parameter of the wrong type for the provider", () => {
    const { registry, threads } = setup();

    expect(registry.open({ provider: "bb-thread", params: { threadId: 7 } })).toEqual({ ok: false, reason: "invalid-ref" });
    expect(threads.opens).toEqual([]);
  });

  it("refuses an id the generator has already issued", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: { nextId: () => "same" } });
    registry.registerProvider(new FakeProvider("bb-thread"));
    await openSettled(registry, threadA);

    expect(() => registry.open(threadB)).toThrow("same");
    expect(registry.list()).toHaveLength(1);
  });

  it.each([
    ["session-ended", "session-ended"],
    ["access-denied", "access-denied"],
    ["lost", "lost"],
  ] as const)("shows the provider's answer %s as the state %s and does not ask again", async (status, state) => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status });

    const first = await openSettled(registry, threadA);
    const second = await openSettled(registry, threadA);

    expect(first).toMatchObject({ instanceId: "panel-1", state, unknownOutcome: null });
    expect(second).toMatchObject({ instanceId: "panel-1", state });
    expect(threads.opens).toEqual(["panel-1"]);
  });
});

describe("unknown outcome of opening", () => {
  it("marks the panel lost and never opens the same reference again on its own", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => {
      throw new Error("transport closed");
    };

    const first = await openSettled(registry, threadA);
    const second = await openSettled(registry, threadA);

    expect(first).toMatchObject({ instanceId: "panel-1", state: "lost", unknownOutcome: "open" });
    expect(second).toMatchObject({ instanceId: "panel-1", state: "lost", unknownOutcome: "open" });
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("treats an explicit unknown answer the same way", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "unknown" });

    expect(await openSettled(registry, threadA)).toMatchObject({ state: "lost", unknownOutcome: "open" });
    await openSettled(registry, threadA);
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("opens again only on an explicit retry, keeping the instance id", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "unknown" });
    await openSettled(registry, threadA);
    threads.openResult = async () => ({ status: "live", addressee: null });

    const retried = registry.retryOpen("panel-1");

    expect(retried.ok && retried.instance).toMatchObject({ instanceId: "panel-1", state: "loading", unknownOutcome: null });
    if (retried.ok) expect(await retried.settled).toMatchObject({ instanceId: "panel-1", state: "live" });
    expect(threads.opens).toEqual(["panel-1", "panel-1"]);
  });

  it("refuses a retry for a live, loading or unknown panel", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;
    registry.open(threadB);

    expect(registry.retryOpen("panel-1")).toEqual({ ok: false, reason: "already-live" });
    expect(registry.retryOpen("panel-2")).toEqual({ ok: false, reason: "busy" });
    expect(registry.retryOpen("panel-9")).toEqual({ ok: false, reason: "not-open" });
    expect(threads.opens).toEqual(["panel-1", "panel-2"]);
  });
});

describe("missing provider", () => {
  it("keeps the reference and shows the provider as missing", async () => {
    const { registry } = setup();

    const instance = await openSettled(registry, call);

    expect(instance).toMatchObject({
      instanceId: "panel-1",
      ref: { provider: "zoom", params: { meeting: "standup" } },
      state: "provider-missing",
    });
    expect(registry.list().map((item) => item.ref)).toEqual([{ provider: "zoom", params: { meeting: "standup" } }]);
  });

  it("opens the kept reference once the provider appears, under the same instance id", async () => {
    const { registry } = setup();
    await openSettled(registry, call);
    const zoom = new FakeProvider("zoom");
    registry.registerProvider(zoom);

    expect(registry.get("panel-1")?.state).toBe("provider-missing");
    expect(zoom.opens).toEqual([]);

    const instance = await openSettled(registry, call);

    expect(instance).toMatchObject({ instanceId: "panel-1", state: "live" });
    expect(zoom.opens).toEqual(["panel-1"]);
  });

  it("does not hand a kept reference to a provider that does not declare its parameters", async () => {
    const { registry } = setup();
    await openSettled(registry, { provider: "zoom", params: { meeting: "standup", note: "hello" } });
    const zoom = new FakeProvider("zoom");
    registry.registerProvider(zoom);

    expect(registry.open({ provider: "zoom", params: { meeting: "standup", note: "hello" } })).toEqual({
      ok: false,
      reason: "invalid-ref",
    });
    expect(registry.retryOpen("panel-1")).toEqual({ ok: false, reason: "invalid-ref" });
    expect(zoom.opens).toEqual([]);
    expect(registry.get("panel-1")).toMatchObject({
      state: "provider-missing",
      ref: { provider: "zoom", params: { meeting: "standup", note: "hello" } },
    });
  });

  it("closes a panel whose provider never appeared without releasing anything", async () => {
    const { registry } = setup();
    await openSettled(registry, call);

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "not-needed" });
    expect(registry.list()).toEqual([]);
  });

  it("marks live panels lost when their provider goes away and keeps their references", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    const zoom = new FakeProvider("zoom");
    const unregister = registry.registerProvider(zoom);
    await openSettled(registry, call);

    unregister();

    expect(registry.get("panel-1")).toMatchObject({ state: "lost", ref: { provider: "zoom", params: { meeting: "standup" } } });
  });

  it("keeps a never-opened panel waiting when a provider comes and goes without being asked", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    await openSettled(registry, call);
    const before = new FakeProvider("zoom");
    registry.registerProvider(before)();
    const after = new FakeProvider("zoom");
    registry.registerProvider(after);

    const again = await openSettled(registry, call);

    expect(before.opens).toEqual([]);
    expect(again).toMatchObject({ instanceId: "panel-1", state: "live" });
    expect(after.opens).toEqual(["panel-1"]);
  });

  it("leaves a panel that was live lost after its provider returns, until an explicit retry", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    const before = new FakeProvider("zoom");
    const unregister = registry.registerProvider(before);
    await openSettled(registry, call);
    unregister();
    const after = new FakeProvider("zoom");
    registry.registerProvider(after);

    const again = await openSettled(registry, call);

    expect(again).toMatchObject({ instanceId: "panel-1", state: "lost" });
    expect(after.opens).toEqual([]);

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "not-needed" });
    expect(before.releases).toEqual([]);
    expect(after.releases).toEqual([]);
  });

  it("ignores the answer of a provider that went away while opening", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    const zoom = new FakeProvider("zoom");
    const pending = deferred<PanelOpenOutcome>();
    zoom.openResult = () => pending.promise;
    const unregister = registry.registerProvider(zoom);
    const opened = registry.open(call);

    unregister();
    pending.resolve({ status: "live", addressee: "call:standup" });

    if (opened.ok) expect(await opened.settled).toMatchObject({ state: "lost", addressee: null });
    expect(registry.get("panel-1")).toMatchObject({ state: "lost", addressee: null });
  });

  it("refuses a second provider of the same type", () => {
    const { registry } = setup();
    expect(() => registry.registerProvider(new FakeProvider("bb-thread"))).toThrow("bb-thread");
  });

  it("does not unregister a newer provider through an old handle", async () => {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    const unregisterOld = registry.registerProvider(new FakeProvider("zoom"));
    unregisterOld();
    const current = new FakeProvider("zoom");
    registry.registerProvider(current);

    unregisterOld();

    expect(await openSettled(registry, call)).toMatchObject({ state: "live" });
    expect(current.opens).toEqual(["panel-1"]);
  });
});

describe("removing from the layout", () => {
  it("keeps the instance live and hidden, and releases nothing", async () => {
    const { clock, registry, threads } = setup();
    await openSettled(registry, threadA);
    await openSettled(registry, threadB);
    clock.time = 2500;

    expect(registry.removeFromLayout("panel-1")).toBe(true);

    expect(registry.get("panel-1")).toMatchObject({ state: "live", placed: false, hiddenAt: 2500 });
    expect(registry.hiddenLive().map((item) => item.instanceId)).toEqual(["panel-1"]);
    expect(threads.releases).toEqual([]);
    expect(threads.endSessions).toEqual([]);
  });

  it("puts the same instance back without opening it again", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    registry.removeFromLayout("panel-1");

    expect(registry.returnToLayout("panel-1")).toBe(true);

    expect(registry.get("panel-1")).toMatchObject({ state: "live", placed: true, hiddenAt: null });
    expect(registry.hiddenLive()).toEqual([]);
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("reuses a hidden instance when its reference is opened again", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    registry.removeFromLayout("panel-1");

    const again = await openSettled(registry, threadA);

    expect(again).toMatchObject({ instanceId: "panel-1", state: "live", placed: true, hiddenAt: null });
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("lists a hidden panel that is still loading and leaves out one whose session ended", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "session-ended" });
    await openSettled(registry, threadA);
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;
    registry.open(threadB);

    registry.removeFromLayout("panel-1");
    registry.removeFromLayout("panel-2");

    expect(registry.hiddenLive().map((item) => [item.instanceId, item.state])).toEqual([["panel-2", "loading"]]);
  });

  it("reports an instance that is not open", () => {
    const { registry } = setup();
    expect(registry.removeFromLayout("panel-9")).toBe(false);
    expect(registry.returnToLayout("panel-9")).toBe(false);
  });
});

describe("closing", () => {
  it("releases the view exactly once and is safe to repeat", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
    expect(await registry.close("panel-1")).toEqual({ status: "not-open" });
    expect(await registry.close("panel-1")).toEqual({ status: "not-open" });

    expect(threads.releases).toEqual(["panel-1"]);
    expect(threads.endSessions).toEqual([]);
    expect(registry.get("panel-1")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("releases once when two closes overlap", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    const releasing = deferred<void>();
    threads.releaseResult = () => releasing.promise;

    const first = registry.close("panel-1");
    const second = registry.close("panel-1");
    releasing.resolve();

    expect(await first).toEqual({ status: "closed", release: "done" });
    expect(await second).toEqual({ status: "not-open" });
    expect(threads.releases).toEqual(["panel-1"]);
  });

  it("closes a hidden panel", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    registry.removeFromLayout("panel-1");

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
    expect(registry.hiddenLive()).toEqual([]);
    expect(threads.releases).toEqual(["panel-1"]);
  });

  it("reports a failed release without releasing again", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    threads.releaseResult = () => {
      throw new Error("view already gone");
    };

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "failed" });
    expect(await registry.close("panel-1")).toEqual({ status: "not-open" });
    expect(threads.releases).toEqual(["panel-1"]);
  });

  it("releases a panel closed while loading and ignores the late answer", async () => {
    const { registry, threads } = setup();
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;
    const opened = registry.open(threadA);

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
    pending.resolve({ status: "live", addressee: "thread:thr_a" });

    expect(opened.ok && (await opened.settled)).toBeNull();
    expect(threads.releases).toEqual(["panel-1"]);
    expect(registry.get("panel-1")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("opens a closed reference as a new instance", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    await registry.close("panel-1");

    const again = await openSettled(registry, threadA);

    expect(again.instanceId).toBe("panel-2");
    expect(threads.opens).toEqual(["panel-1", "panel-2"]);
    expect(threads.releases).toEqual(["panel-1"]);
  });
});

describe("closing the last view of a session", () => {
  function setupCall() {
    const registry = new PanelRegistry({ clock: new FakeClock(0), ids: new SequentialIds() });
    const zoom = new FakeProvider("zoom");
    zoom.endsSession = true;
    registry.registerProvider(zoom);
    return { registry, zoom };
  }

  it("warns before closing and leaves the panel live and unreleased", async () => {
    const { registry, zoom } = setupCall();
    await openSettled(registry, call);

    expect(await registry.close("panel-1")).toEqual({ status: "needs-confirmation", warning: "ends-session" });

    expect(registry.get("panel-1")).toMatchObject({ state: "live", placed: true });
    expect(zoom.releases).toEqual([]);
    expect(zoom.endSessions).toEqual([]);
  });

  it("lets the user hide the panel instead", async () => {
    const { registry, zoom } = setupCall();
    await openSettled(registry, call);
    await registry.close("panel-1");

    registry.removeFromLayout("panel-1");

    expect(registry.hiddenLive().map((item) => item.instanceId)).toEqual(["panel-1"]);
    expect(zoom.releases).toEqual([]);
  });

  it("closes after confirmation with one release and no separate end of session", async () => {
    const { registry, zoom } = setupCall();
    await openSettled(registry, call);

    expect(await registry.close("panel-1", { confirmEndsSession: true })).toEqual({ status: "closed", release: "done" });

    expect(zoom.releases).toEqual(["panel-1"]);
    expect(zoom.endSessions).toEqual([]);
  });

  it("warns only for the last of several views", async () => {
    const { registry, zoom } = setupCall();
    zoom.multipleViews = true;
    await openSettled(registry, call);
    await openSettled(registry, call, true);

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
    expect(await registry.close("panel-2")).toEqual({ status: "needs-confirmation", warning: "ends-session" });
    expect(zoom.releases).toEqual(["panel-1"]);
  });

  it("warns for the only confirmed view while a second view is still loading", async () => {
    const { registry, zoom } = setupCall();
    zoom.multipleViews = true;
    await openSettled(registry, call);
    const pending = deferred<PanelOpenOutcome>();
    zoom.openResult = () => pending.promise;
    registry.open(call, { newView: true });

    expect(await registry.close("panel-1")).toEqual({ status: "needs-confirmation", warning: "ends-session" });
    pending.resolve({ status: "access-denied" });

    expect(registry.get("panel-1")?.state).toBe("live");
    expect(zoom.releases).toEqual([]);
  });

  it("closes a loading view without a warning while another view is confirmed live", async () => {
    const { registry, zoom } = setupCall();
    zoom.multipleViews = true;
    await openSettled(registry, call);
    const pending = deferred<PanelOpenOutcome>();
    zoom.openResult = () => pending.promise;
    registry.open(call, { newView: true });

    expect(await registry.close("panel-2")).toEqual({ status: "closed", release: "done" });
    expect(zoom.releases).toEqual(["panel-2"]);
  });

  it("warns before releasing a view whose open had an unknown outcome", async () => {
    const { registry, zoom } = setupCall();
    zoom.openResult = async () => ({ status: "unknown" });
    await openSettled(registry, call);

    expect(await registry.close("panel-1")).toEqual({ status: "needs-confirmation", warning: "ends-session" });
    expect(zoom.releases).toEqual([]);
    expect(registry.get("panel-1")).toMatchObject({ state: "lost", unknownOutcome: "open" });

    expect(await registry.close("panel-1", { confirmEndsSession: true })).toEqual({ status: "closed", release: "done" });
    expect(zoom.releases).toEqual(["panel-1"]);
  });

  it("does not count a view with an unknown outcome as a second confirmed view", async () => {
    const { registry, zoom } = setupCall();
    zoom.multipleViews = true;
    await openSettled(registry, call);
    zoom.openResult = async () => ({ status: "unknown" });
    await openSettled(registry, call, true);

    expect(await registry.close("panel-1")).toEqual({ status: "needs-confirmation", warning: "ends-session" });
    expect(zoom.releases).toEqual([]);
  });

  it("does not warn when the session has already ended", async () => {
    const { registry, zoom } = setupCall();
    await openSettled(registry, call);
    await registry.endSession("panel-1");

    expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
    expect(zoom.releases).toEqual(["panel-1"]);
  });
});

describe("ending the session", () => {
  it("is delegated to the provider once, on the explicit call only", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    registry.removeFromLayout("panel-1");
    registry.returnToLayout("panel-1");
    expect(threads.endSessions).toEqual([]);

    expect(await registry.endSession("panel-1")).toEqual({ status: "ended" });

    expect(threads.endSessions).toEqual(["panel-1"]);
    expect(registry.get("panel-1")).toMatchObject({ state: "session-ended", unknownOutcome: null });
    expect(threads.releases).toEqual([]);
  });

  it("ends every view of the same session and leaves other sessions live", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    await openSettled(registry, threadA);
    await openSettled(registry, threadA, true);
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_b" });
    await openSettled(registry, threadB);

    expect(await registry.endSession("panel-1")).toEqual({ status: "ended" });

    expect(registry.get("panel-2")).toMatchObject({ state: "session-ended", addressee: null });
    expect(registry.addresseeOf("panel-2")).toBeNull();
    expect(registry.get("panel-3")).toMatchObject({ state: "live", addressee: "thread:thr_b" });
    expect(threads.endSessions).toEqual(["panel-1"]);
    expect(await registry.endSession("panel-2")).toEqual({ status: "not-live" });
    expect(threads.endSessions).toEqual(["panel-1"]);
  });

  it("does not show a view that was loading when the session ended as live", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    await openSettled(registry, threadA);
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;
    const second = registry.open(threadA, { newView: true });

    await registry.endSession("panel-1");
    pending.resolve({ status: "live", addressee: "thread:thr_a" });

    expect(second.ok && (await second.settled)).toMatchObject({ instanceId: "panel-2", state: "session-ended", addressee: null });
    expect(registry.addresseeOf("panel-2")).toBeNull();
  });

  it("leaves the other views as they are after an unknown answer", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    await openSettled(registry, threadA);
    await openSettled(registry, threadA, true);
    threads.endSessionResult = async () => "unknown";

    await registry.endSession("panel-1");

    expect(registry.get("panel-2")).toMatchObject({ state: "live", unknownOutcome: null });
  });

  it("is refused for a panel that is not live", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    await registry.endSession("panel-1");

    expect(await registry.endSession("panel-1")).toEqual({ status: "not-live" });
    expect(await registry.endSession("panel-9")).toEqual({ status: "not-open" });
    expect(threads.endSessions).toEqual(["panel-1"]);
  });

  it("reaches the provider once when two calls overlap", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    const ending = deferred<"ended">();
    threads.endSessionResult = () => ending.promise;

    const first = registry.endSession("panel-1");
    const second = registry.endSession("panel-1");
    ending.resolve("ended");

    expect(await second).toEqual({ status: "busy" });
    expect(await first).toEqual({ status: "ended" });
    expect(threads.endSessions).toEqual(["panel-1"]);
  });

  it.each([
    ["an unknown answer", async () => "unknown" as const],
    [
      "a failed call",
      async () => {
        throw new Error("transport closed");
      },
    ],
  ])("keeps the panel live and flagged after %s, and does not repeat the call", async (_name, result) => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    threads.endSessionResult = result;

    expect(await registry.endSession("panel-1")).toEqual({ status: "unknown" });

    expect(registry.get("panel-1")).toMatchObject({ state: "live", unknownOutcome: "end-session" });
    expect(threads.endSessions).toEqual(["panel-1"]);
    expect(threads.opens).toEqual(["panel-1"]);
  });

  it("ends the other views when the view the user acted in was closed before the answer", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    await openSettled(registry, threadA);
    await openSettled(registry, threadA, true);
    const ending = deferred<"ended">();
    threads.endSessionResult = () => ending.promise;

    const result = registry.endSession("panel-1");
    await registry.close("panel-1");
    ending.resolve("ended");

    expect(await result).toEqual({ status: "ended" });
    expect(registry.get("panel-2")).toMatchObject({ state: "session-ended", addressee: null });
    expect(registry.addresseeOf("panel-2")).toBeNull();
  });

  it("does not turn a panel closed during the call into an ended one", async () => {
    const { registry, threads } = setup();
    await openSettled(registry, threadA);
    const ending = deferred<"ended">();
    threads.endSessionResult = () => ending.promise;

    const result = registry.endSession("panel-1");
    await registry.close("panel-1");
    ending.resolve("ended");

    expect(await result).toEqual({ status: "ended" });
    expect(registry.get("panel-1")).toBeNull();
  });
});

describe("provider reports", () => {
  it.each([["session-ended"], ["access-denied"], ["lost"]] as const)("moves a live panel to %s", async (state) => {
    const { registry } = setup();
    await openSettled(registry, threadA);

    expect(registry.report("panel-1", state)).toBe(true);
    expect(registry.get("panel-1")).toMatchObject({ state, addressee: null });
  });

  it("ends every view of the session when the provider reports its end", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    await openSettled(registry, threadA);
    await openSettled(registry, threadA, true);
    const pending = deferred<PanelOpenOutcome>();
    threads.openResult = () => pending.promise;
    const third = registry.open(threadA, { newView: true });
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_b" });
    await openSettled(registry, threadB);

    expect(registry.report("panel-1", "session-ended")).toBe(true);
    pending.resolve({ status: "live", addressee: "thread:thr_a" });

    expect(registry.get("panel-2")).toMatchObject({ state: "session-ended", addressee: null });
    expect(registry.addresseeOf("panel-2")).toBeNull();
    expect(third.ok && (await third.settled)).toMatchObject({ instanceId: "panel-3", state: "session-ended", addressee: null });
    expect(registry.get("panel-4")).toMatchObject({ state: "live", addressee: "thread:thr_b" });
  });

  it.each([["access-denied"], ["lost"]] as const)("keeps the other views live when one view reports %s", async (state) => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    await openSettled(registry, threadA);
    await openSettled(registry, threadA, true);

    registry.report("panel-1", state);

    expect(registry.get("panel-2")).toMatchObject({ state: "live", addressee: "thread:thr_a" });
  });

  it("ends the other views when a new view is told the session is over", async () => {
    const { registry, threads } = setup();
    threads.multipleViews = true;
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    await openSettled(registry, threadA);
    threads.openResult = async () => ({ status: "session-ended" });

    await openSettled(registry, threadA, true);

    expect(registry.get("panel-1")).toMatchObject({ state: "session-ended", addressee: null });
    expect(registry.addresseeOf("panel-1")).toBeNull();
  });

  it("is ignored for a panel that is not live", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "access-denied" });
    await openSettled(registry, threadA);

    expect(registry.report("panel-1", "lost")).toBe(false);
    expect(registry.report("panel-9", "lost")).toBe(false);
    expect(registry.get("panel-1")?.state).toBe("access-denied");
  });
});

describe("addressee", () => {
  it("is known only while the panel is live", async () => {
    const { registry, threads } = setup();
    threads.openResult = async () => ({ status: "live", addressee: "thread:thr_a" });
    const pending = registry.open(threadA);
    expect(registry.addresseeOf("panel-1")).toBeNull();
    if (pending.ok) await pending.settled;

    expect(registry.addresseeOf("panel-1")).toBe("thread:thr_a");
    expect(registry.addresseeOf("panel-9")).toBeNull();

    registry.report("panel-1", "session-ended");
    expect(registry.addresseeOf("panel-1")).toBeNull();
  });

  it("follows the provider's change and is forgotten on close", async () => {
    const { registry } = setup();
    await openSettled(registry, threadA);

    expect(registry.setAddressee("panel-1", "telegram:acc_1/chat_2")).toBe(true);
    expect(registry.addresseeOf("panel-1")).toBe("telegram:acc_1/chat_2");
    expect(registry.setAddressee("panel-1", null)).toBe(true);
    expect(registry.addresseeOf("panel-1")).toBeNull();

    await registry.close("panel-1");
    expect(registry.setAddressee("panel-1", "thread:thr_a")).toBe(false);
    expect(registry.addresseeOf("panel-1")).toBeNull();
  });
});

describe("snapshots and subscription", () => {
  it("hands out snapshots that do not change the registry", async () => {
    const { registry } = setup();
    const snapshot = await openSettled(registry, threadA);

    expect(() => {
      (snapshot as { state: string }).state = "lost";
    }).toThrow();
    expect(() => {
      (snapshot.ref.params as Record<string, string>).threadId = "thr_x";
    }).toThrow();
    expect(registry.get("panel-1")).toMatchObject({ state: "live", ref: { params: { threadId: "thr_a" } } });
  });

  it("notifies a subscriber of each change until it unsubscribes", async () => {
    const { registry } = setup();
    const seen: string[] = [];
    const unsubscribe = registry.subscribe(() => {
      seen.push(registry.list().map((item) => item.state + (item.placed ? "" : ":hidden")).join(","));
    });

    await openSettled(registry, threadA);
    registry.removeFromLayout("panel-1");
    await registry.close("panel-1");
    unsubscribe();
    await openSettled(registry, threadB);

    expect(seen).toEqual(["loading", "live", "live:hidden", ""]);
  });
});
