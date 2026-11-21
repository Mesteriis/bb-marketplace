import { describe, expect, it } from "vitest";
import { createHomeRedirectController } from "../../../src/adapters/bb/home/controller.ts";
import { createNewThreadPass, type HomeArrivalFacts } from "../../../src/core/home/index.ts";

const onHome: HomeArrivalFacts = { setting: "on", surface: "stock-home", projectId: null, split: false };

interface PanelCall {
  path: string;
  options: { subPath?: string; replace?: boolean } | undefined;
}

/** Navigation that records calls instead of moving anywhere. */
function fakeNavigation() {
  const calls: PanelCall[] = [];
  return {
    calls,
    toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }) {
      calls.push({ path, options });
    },
  };
}

/** A clock and a deferral queue the test runs by hand. */
function harness(startAt = 1000) {
  const pass = createNewThreadPass();
  const deferred: Array<() => void> = [];
  let time = startAt;
  const controller = createHomeRedirectController({
    panelPath: "home",
    pass,
    now: () => time,
    defer: (task) => deferred.push(task),
  });
  return {
    controller,
    pass,
    navigation: fakeNavigation(),
    tick(ms: number) {
      time += ms;
    },
    time: () => time,
    flush() {
      for (const task of deferred.splice(0)) task();
    },
  };
}

describe("home redirect controller", () => {
  it("navigates to the Chertog panel exactly once, replacing the Home history entry", () => {
    const h = harness();
    h.controller.mount();
    h.controller.observe(onHome, h.navigation);
    h.controller.observe(onHome, h.navigation);
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([{ path: "home", options: { replace: true } }]);
  });

  it("does not navigate when the setting is off", () => {
    const h = harness();
    h.controller.mount();
    expect(h.controller.observe({ ...onHome, setting: "off" }, h.navigation)).toEqual({ action: "stay", reason: "disabled" });
    expect(h.navigation.calls).toEqual([]);
  });

  it("does not navigate while the setting is unknown, then navigates once when it turns out on", () => {
    const h = harness();
    h.controller.mount();
    h.controller.observe({ ...onHome, setting: "unknown" }, h.navigation);
    expect(h.navigation.calls).toEqual([]);
    h.controller.observe(onHome, h.navigation);
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([{ path: "home", options: { replace: true } }]);
  });

  it("does not navigate on the arrival a pass announced, and spends the pass", () => {
    const h = harness();
    h.pass.grant(h.time());
    h.tick(20);
    h.controller.mount();
    expect(h.controller.observe(onHome, h.navigation)).toEqual({ action: "stay", reason: "new-thread-pass" });
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([]);
    expect(h.pass.consume(h.time())).toBe(false);
  });

  it("navigates on the visit after the one a pass let through", () => {
    const h = harness();
    h.pass.grant(h.time());
    const unmount = h.controller.mount();
    h.controller.observe(onHome, h.navigation);
    unmount();
    h.flush();
    h.controller.mount();
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([{ path: "home", options: { replace: true } }]);
  });

  it("navigates when the pass is older than five seconds", () => {
    const h = harness();
    h.pass.grant(h.time());
    h.tick(5001);
    h.controller.mount();
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([{ path: "home", options: { replace: true } }]);
  });

  it("does not navigate for a project or a split", () => {
    const h = harness();
    const unmount = h.controller.mount();
    h.controller.observe({ ...onHome, projectId: "prj_1" }, h.navigation);
    unmount();
    h.flush();
    h.controller.mount();
    h.controller.observe({ ...onHome, split: true }, h.navigation);
    expect(h.navigation.calls).toEqual([]);
  });

  it("does not navigate again when the host remounts the section in one update", () => {
    const h = harness();
    h.pass.grant(h.time());
    const unmount = h.controller.mount();
    h.controller.observe(onHome, h.navigation);
    unmount();
    h.controller.mount();
    h.flush();
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([]);
  });

  it("navigates once per visit across three separate visits", () => {
    const h = harness();
    for (let visit = 0; visit < 3; visit += 1) {
      const unmount = h.controller.mount();
      h.controller.observe(onHome, h.navigation);
      h.controller.observe(onHome, h.navigation);
      unmount();
      h.flush();
    }
    expect(h.navigation.calls).toEqual([
      { path: "home", options: { replace: true } },
      { path: "home", options: { replace: true } },
      { path: "home", options: { replace: true } },
    ]);
  });

  it("does not navigate before the section is mounted or after it is gone", () => {
    const h = harness();
    h.controller.observe(onHome, h.navigation);
    const unmount = h.controller.mount();
    unmount();
    h.flush();
    h.controller.observe(onHome, h.navigation);
    expect(h.navigation.calls).toEqual([]);
  });

  it("counts an unmount once, even when the cleanup runs twice", () => {
    const h = harness();
    const first = h.controller.mount();
    h.controller.mount();
    first();
    first();
    h.flush();
    h.controller.observe({ ...onHome, setting: "off" }, h.navigation);
    expect(h.controller.observe(onHome, h.navigation)).toEqual({ action: "stay", reason: "decided" });
  });

  it.each(["", " ", "/home", "home/"])("refuses the panel path %j", (panelPath) => {
    expect(() => createHomeRedirectController({ panelPath, pass: createNewThreadPass() })).toThrow(RangeError);
  });
});
