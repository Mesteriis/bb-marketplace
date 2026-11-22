// The adapter that keeps makosh-navigation and makosh-sidebar in step with
// the navigationPart and threadListPart switches, over a fake SDK.
import { describe, expect, it } from "vitest";
import { startPartSync } from "../../../src/adapters/bb/server/parts-sync.ts";
import { FakeLog } from "./support.ts";

type Values = Record<string, boolean | undefined>;

class FakePlugins {
  readonly calls: string[] = [];
  /** Plugin ids that refuse the next call, with the message. */
  readonly failures = new Map<string, string>();
  constructor(private readonly inventory: { id: string; enabled: boolean }[]) {}
  async list() {
    this.calls.push("list");
    return { plugins: this.inventory.map((plugin) => ({ ...plugin })) };
  }
  private async change(verb: "enable" | "disable", pluginId: string) {
    this.calls.push(`${verb} ${pluginId}`);
    const failure = this.failures.get(pluginId);
    if (failure !== undefined) throw new Error(failure);
    const entry = this.inventory.find((plugin) => plugin.id === pluginId);
    if (entry) entry.enabled = verb === "enable";
    return entry;
  }
  enable = ({ pluginId }: { pluginId: string }) => this.change("enable", pluginId);
  disable = ({ pluginId }: { pluginId: string }) => this.change("disable", pluginId);
  state(pluginId: string) {
    return this.inventory.find((plugin) => plugin.id === pluginId)?.enabled;
  }
}

class FakeHandle {
  private listeners: ((next: Values, prev: Values) => void)[] = [];
  constructor(public values: Values) {}
  get = async () => ({ ...this.values });
  onChange = (listener: (next: Values, prev: Values) => void) => void this.listeners.push(listener);
  /** A settings write as BB reports it. */
  write(patch: Values): void {
    const prev = this.values;
    this.values = { ...prev, ...patch };
    for (const listener of this.listeners) listener({ ...this.values }, { ...prev });
  }
}

function setup(values: Values, inventory: { id: string; enabled: boolean }[]) {
  const handle = new FakeHandle(values);
  const plugins = new FakePlugins(inventory);
  const log = new FakeLog();
  const sync = startPartSync({ settings: handle, plugins: () => plugins as never, log });
  return { handle, plugins, log, sync };
}

const both = [
  { id: "makosh-navigation", enabled: true },
  { id: "makosh-sidebar", enabled: true },
];

describe("startPartSync", () => {
  it("disables the plugin of a switch that is off at start, and leaves the other alone", async () => {
    const { plugins, sync } = setup({ navigationPart: false, threadListPart: true }, both.map((p) => ({ ...p })));
    await sync.idle();
    expect(plugins.calls).toEqual(["list", "disable makosh-navigation"]);
  });

  it("enables a plugin that is off while its switch is on", async () => {
    const { plugins, sync } = setup({ navigationPart: true, threadListPart: true }, [
      { id: "makosh-navigation", enabled: true },
      { id: "makosh-sidebar", enabled: false },
    ]);
    await sync.idle();
    expect(plugins.calls).toEqual(["list", "enable makosh-sidebar"]);
  });

  it("calls nothing when the plugins already match, and reads a missing key as on", async () => {
    const { plugins, sync } = setup({}, both.map((p) => ({ ...p })));
    await sync.idle();
    expect(plugins.calls).toEqual(["list"]);
  });

  it("follows a change of the switch without a restart, both ways", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true, threadListPart: true }, both.map((p) => ({ ...p })));
    await sync.idle();
    handle.write({ threadListPart: false });
    await sync.idle();
    expect(plugins.state("makosh-sidebar")).toBe(false);
    handle.write({ threadListPart: true });
    await sync.idle();
    expect(plugins.state("makosh-sidebar")).toBe(true);
    expect(plugins.calls.filter((call) => call !== "list")).toEqual(["disable makosh-sidebar", "enable makosh-sidebar"]);
  });

  it("serializes changes that arrive together and ends on the last value", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true }, both.map((p) => ({ ...p })));
    await sync.idle();
    handle.write({ navigationPart: false });
    handle.write({ navigationPart: true });
    handle.write({ navigationPart: false });
    await sync.idle();
    expect(plugins.state("makosh-navigation")).toBe(false);
  });

  it("does nothing for a plugin that is not installed and says so once", async () => {
    const { handle, plugins, log, sync } = setup({ navigationPart: false, threadListPart: false }, [{ id: "makosh-sidebar", enabled: true }]);
    await sync.idle();
    handle.write({ navigationPart: false });
    await sync.idle();
    expect(plugins.calls.filter((call) => call !== "list")).toEqual(["disable makosh-sidebar"]);
    expect(log.lines.filter((line) => line.includes("makosh-navigation"))).toHaveLength(1);
  });

  it("survives a refusal, logs one line per new state, and retries on the next change", async () => {
    const { handle, plugins, log, sync } = setup({ navigationPart: false }, both.map((p) => ({ ...p })));
    plugins.failures.set("makosh-navigation", "no permission");
    await sync.idle();
    handle.write({ homeRedirect: true });
    await sync.idle();
    expect(plugins.calls.filter((call) => call === "disable makosh-navigation")).toHaveLength(2);
    const warnings = log.lines.filter((line) => line.startsWith("warn"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("makosh-navigation");
    expect(warnings[0]).toContain("no permission");
    plugins.failures.set("makosh-navigation", "host refused");
    handle.write({ homeRedirect: false });
    await sync.idle();
    expect(log.lines.filter((line) => line.startsWith("warn"))).toHaveLength(2);
    plugins.failures.clear();
    handle.write({ homeRedirect: true });
    await sync.idle();
    expect(plugins.state("makosh-navigation")).toBe(false);
  });

  it("survives a failing inventory read and a failing settings read", async () => {
    const handle = new FakeHandle({ navigationPart: false });
    const log = new FakeLog();
    const plugins = { list: async () => { throw new Error("inventory down"); } };
    const sync = startPartSync({ settings: handle, plugins: () => plugins as never, log });
    await sync.idle();
    expect(log.lines.some((line) => line.startsWith("warn") && line.includes("inventory down"))).toBe(true);
    const broken = startPartSync({ settings: { get: async () => { throw new Error("settings down"); }, onChange() {} }, plugins: () => plugins as never, log });
    await expect(broken.idle()).resolves.toBeUndefined();
  });
});
