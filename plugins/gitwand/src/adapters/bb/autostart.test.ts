import { describe, expect, it, vi } from "vitest";
import { autostart } from "./autostart.ts";

function deps(over: Partial<Parameters<typeof autostart>[0]> = {}) {
  const calls: string[] = [];
  const d: Parameters<typeof autostart>[0] = {
    hasRuntime: () => true,
    installFirst: async () => {
      calls.push("installFirst");
      return true;
    },
    start: async () => {
      calls.push("start");
    },
    log: (message) => calls.push(`log:${message}`),
    ...over,
  };
  return { d, calls };
}

describe("autostart", () => {
  it("starts the bridge when a runtime is installed", async () => {
    const { d, calls } = deps();
    await autostart(d);
    expect(calls).toEqual(["start"]);
  });

  it("installs the first runtime from the channel, then starts the bridge", async () => {
    let installed = false;
    const { d, calls } = deps({
      hasRuntime: () => installed,
      installFirst: async () => {
        calls.push("installFirst");
        installed = true;
        return true;
      },
    });
    await autostart(d);
    expect(calls).toEqual(["installFirst", "start"]);
  });

  it("does not start when no runtime is installed and the channel offers none", async () => {
    const { d, calls } = deps({ hasRuntime: () => false, installFirst: async () => false });
    await autostart(d);
    expect(calls).toEqual(["log:GitWand runtime is not installed and the update channel offers no build; the backend stays stopped"]);
  });

  it("logs a failed start instead of throwing", async () => {
    const { d, calls } = deps({
      start: async () => {
        throw new Error("gitwand-bridge did not answer __hello within 5000 ms");
      },
    });
    await expect(autostart(d)).resolves.toBeUndefined();
    expect(calls).toEqual(["log:GitWand backend did not start: gitwand-bridge did not answer __hello within 5000 ms"]);
  });

  it("logs a failed first install instead of throwing", async () => {
    const { d, calls } = deps({
      hasRuntime: () => false,
      installFirst: async () => {
        throw new Error("sha256 mismatch");
      },
    });
    await expect(autostart(d)).resolves.toBeUndefined();
    expect(calls).toEqual(["log:GitWand first runtime install failed: sha256 mismatch"]);
  });
});

describe("restartAfterCrash", () => {
  it("starts again after an unexpected exit while not failed", async () => {
    const { restartAfterCrash } = await import("./autostart.ts");
    const start = vi.fn(async () => {});
    const log = vi.fn();
    await restartAfterCrash({ state: () => "stopped", start, log });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not restart a failed bridge (crash loop guard)", async () => {
    const { restartAfterCrash } = await import("./autostart.ts");
    const start = vi.fn(async () => {});
    await restartAfterCrash({ state: () => "failed", start, log: vi.fn() });
    expect(start).not.toHaveBeenCalled();
  });

  it("logs a failed restart instead of throwing", async () => {
    const { restartAfterCrash } = await import("./autostart.ts");
    const log = vi.fn();
    await restartAfterCrash({
      state: () => "stopped",
      start: async () => {
        throw new Error("boom");
      },
      log,
    });
    expect(log).toHaveBeenCalledWith("GitWand backend did not restart: boom");
  });
});
