import { describe, expect, it } from "vitest";
import type { WindowStatusWire } from "../contract.ts";
import { createHostHandlers, type HostCallContext } from "../src/adapters/bb/host-handlers.ts";
import type { RunningWindow } from "../src/adapters/bb/native-window.ts";

// A call context that behaves like BB's host worker: the worker lease can be
// taken only while the call that owns the context is running.
function call() {
  let active = true;
  let leases = 0;
  const signals: WindowStatusWire[] = [];
  const context: HostCallContext = {
    experimental_paths: { dataDir: "/data", tempDir: "/tmp" },
    experimental_retainWorker() {
      if (!active) throw new Error("host call context is no longer active");
      leases += 1;
      return { dispose: () => void (leases -= 1) };
    },
    experimental_emitSignal: async (_name, payload) => void signals.push(payload),
    lifecycle: { signal: new AbortController().signal },
  };
  return { context, end: () => void (active = false), leases: () => leases, signals };
}

function stillWindow(): RunningWindow {
  return { evaluate: async () => null, showPanel: () => {}, attach: () => {}, quit: () => {}, exited: new Promise(() => {}) };
}

describe("the host entry's handlers", () => {
  it("opens the window after the page first asked for the status in an earlier call", async () => {
    const handlers = createHostHandlers({ build: async () => ({ ok: true, executable: "/x" }), launch: () => stillWindow() });
    const first = call();
    expect(await handlers.status(first.context)).toEqual({ window: "closed", reason: null, proposal: "none", last: null });
    first.end();

    const second = call();
    const opened = await handlers.open(second.context);

    expect(opened.window).toBe("open");
    expect(second.leases()).toBe(1);
    expect(first.leases()).toBe(0);
  });

  it("proposes through a fresh call too, without reusing an old one", async () => {
    const handlers = createHostHandlers({ build: async () => ({ ok: true, executable: "/x" }), launch: () => stillWindow() });
    const first = call();
    await handlers.status(first.context);
    first.end();

    const second = call();
    const result = await handlers.propose("text", "manual", second.context);

    expect(result.ok).toBe(true);
    expect(second.leases()).toBe(1);
  });

  it("reports status changes through the latest call's signal channel", async () => {
    const handlers = createHostHandlers({ build: async () => ({ ok: true, executable: "/x" }), launch: () => stillWindow() });
    const first = call();
    await handlers.status(first.context);
    first.end();
    const second = call();
    await handlers.open(second.context);

    expect(second.signals.map((s) => s.window)).toEqual(["building", "open"]);
  });

  it("closes the window and releases the worker on dispose", async () => {
    let quit = 0;
    const handlers = createHostHandlers({
      build: async () => ({ ok: true, executable: "/x" }),
      launch: () => ({ ...stillWindow(), quit: () => void (quit += 1) }),
    });
    const one = call();
    await handlers.open(one.context);

    await handlers.dispose();

    expect(quit).toBe(1);
    expect(one.leases()).toBe(0);
  });
});
