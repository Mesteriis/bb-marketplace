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
    attach: (view) => void shown.push(view.visible ? "attach" : "hide"),
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
    onChange: (status) => void statuses.push(status),
    startWaitMs: 50,
  });
  const retain = () => {
    leases += 1;
    return () => void (leases -= 1);
  };
  return { controller, statuses, windows, leases: () => leases, retain };
}

describe("the window controller", () => {
  it("builds once and opens one window, however often it is asked", async () => {
    let builds = 0;
    const { controller, windows, leases, retain } = rig(async () => ((builds += 1), { ok: true, executable: "/x" }));

    expect((await controller.open(retain)).window).toBe("open");
    await controller.open(retain);

    expect(builds).toBe(1);
    expect(windows).toHaveLength(1);
    // The new window is told at once that the page has not placed it yet.
    expect(windows[0]!.shown).toEqual(["hide"]);
    expect(leases()).toBe(1);
  });

  it("keeps the page's placement for a window that starts later, and forwards later ones", async () => {
    const { controller, windows, retain } = rig(async () => ({ ok: true, executable: "/x" }));
    const placed = { owner: "a", visible: true, x: 0, y: 40, width: 800, height: 600, innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 800, screenX: 10, screenY: 20, pixelRatio: 2 };

    controller.attach(placed);
    await controller.open(retain);
    controller.attach({ ...placed, visible: false });

    expect(windows[0]!.shown).toEqual(["attach", "hide"]);
  });

  it("ignores a hide from a page that no longer owns the window, and an area outside the viewport", async () => {
    const { controller, windows, retain } = rig(async () => ({ ok: true, executable: "/x" }));
    const placed = { owner: "a", visible: true, x: 0, y: 40, width: 800, height: 600, innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 800, screenX: 10, screenY: 20, pixelRatio: 2 };
    await controller.open(retain);
    controller.attach(placed);
    controller.attach({ ...placed, owner: "b" });
    controller.attach({ ...placed, owner: "a", visible: false });
    controller.attach({ ...placed, owner: "c", x: -500, width: 3000 });

    expect(windows[0]!.shown).toEqual(["hide", "attach", "attach"]);
  });

  it("releases the worker and reports closed when the window exits", async () => {
    const { controller, windows, leases, statuses, retain } = rig(async () => ({ ok: true, executable: "/x" }));
    await controller.open(retain);

    windows[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(leases()).toBe(0);
    expect(statuses[statuses.length - 1]).toEqual({ window: "closed", reason: null, proposal: "none", last: null });
  });

  it("reports why the window cannot be built", async () => {
    const { controller, leases, retain } = rig(async () => ({ ok: false, reason: "нет компилятора" }));

    expect(await controller.open(retain)).toEqual({ window: "unavailable", reason: "нет компилятора", proposal: "none", last: null });
    expect(leases()).toBe(0);
    expect(await controller.propose("text", "manual", retain)).toEqual({ ok: false, reason: "window-unavailable" });
  });

  it("ends a build that throws in 'unavailable' and releases the worker", async () => {
    const { controller, leases, retain } = rig(async () => {
      throw new Error("ENOSPC");
    });

    const status = await controller.open(retain);

    expect(status.window).toBe("unavailable");
    expect(status.reason).toContain("Окно не собралось");
    expect(leases()).toBe(0);
  });

  it("answers 'building' instead of waiting past the call's time limit", async () => {
    let finish: (value: BuildResult) => void = () => {};
    const { controller, retain } = rig(() => new Promise((resolve) => (finish = resolve)));

    expect((await controller.open(retain)).window).toBe("building");
    expect(await controller.propose("text", "manual", retain)).toEqual({ ok: false, reason: "window-unavailable" });
    finish({ ok: true, executable: "/x" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.status().window).toBe("open");
  });

  it("closes the window and releases the worker on dispose", async () => {
    const { controller, leases, retain } = rig(async () => ({ ok: true, executable: "/x" }));
    await controller.open(retain);

    controller.dispose();

    expect(leases()).toBe(0);
  });
});
