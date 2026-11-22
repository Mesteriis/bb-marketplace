import { describe, expect, it } from "vitest";
import type { WindowStatusWire } from "../contract.ts";
import type { BuildResult, RunningWindow } from "../src/adapters/bb/native-window.ts";
import { createWindowController } from "../src/adapters/bb/window-controller.ts";

function fakeWindow() {
  let exit: () => void = () => {};
  const shown: string[] = [];
  const window: RunningWindow = {
    evaluate: async () => null,
    showPanel: () => {},
    show: () => void shown.push("show"),
    quit: () => exit(),
    exited: new Promise<void>((resolve) => (exit = resolve)),
  };
  return { window, shown, exit: () => exit() };
}

function rig(build: () => Promise<BuildResult>) {
  const statuses: WindowStatusWire[] = [];
  let leases = 0;
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const controller = createWindowController({
    build,
    launch: () => {
      const created = fakeWindow();
      windows.push(created);
      return created.window;
    },
    retain: () => {
      leases += 1;
      return () => void (leases -= 1);
    },
    onChange: (status) => void statuses.push(status),
    startWaitMs: 50,
  });
  return { controller, statuses, windows, leases: () => leases };
}

describe("the window controller", () => {
  it("builds once, opens one window, and only shows it again on a second open", async () => {
    let builds = 0;
    const { controller, windows, leases } = rig(async () => ((builds += 1), { ok: true, executable: "/x" }));

    expect((await controller.open()).window).toBe("open");
    await controller.open();

    expect(builds).toBe(1);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.shown).toEqual(["show"]);
    expect(leases()).toBe(1);
  });

  it("releases the worker and reports closed when the window exits", async () => {
    const { controller, windows, leases, statuses } = rig(async () => ({ ok: true, executable: "/x" }));
    await controller.open();

    windows[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(leases()).toBe(0);
    expect(statuses[statuses.length - 1]).toEqual({ window: "closed", reason: null, proposal: "none", last: null });
  });

  it("reports why the window cannot be built", async () => {
    const { controller, leases } = rig(async () => ({ ok: false, reason: "нет компилятора" }));

    expect(await controller.open()).toEqual({ window: "unavailable", reason: "нет компилятора", proposal: "none", last: null });
    expect(leases()).toBe(0);
    expect(await controller.propose("text", "manual")).toEqual({ ok: false, reason: "window-unavailable" });
  });

  it("answers 'building' instead of waiting past the call's time limit", async () => {
    let finish: (value: BuildResult) => void = () => {};
    const { controller } = rig(() => new Promise((resolve) => (finish = resolve)));

    expect((await controller.open()).window).toBe("building");
    expect(await controller.propose("text", "manual")).toEqual({ ok: false, reason: "window-unavailable" });
    finish({ ok: true, executable: "/x" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.status().window).toBe("open");
  });

  it("closes the window and releases the worker on dispose", async () => {
    const { controller, leases } = rig(async () => ({ ok: true, executable: "/x" }));
    await controller.open();

    controller.dispose();

    expect(leases()).toBe(0);
  });
});
