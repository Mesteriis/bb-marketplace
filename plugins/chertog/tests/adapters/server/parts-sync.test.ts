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
  it("does nothing at start, whatever the switches and the plugins say", async () => {
    const { plugins, log, sync } = setup({ navigationPart: false, threadListPart: true }, [
      { id: "makosh-navigation", enabled: true },
      { id: "makosh-sidebar", enabled: false },
    ]);
    await sync.idle();
    expect(plugins.calls).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("disables the plugin when its switch goes on to off, and enables it when it goes off to on", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true, threadListPart: true }, both.map((p) => ({ ...p })));
    handle.write({ threadListPart: false });
    await sync.idle();
    expect(plugins.state("makosh-sidebar")).toBe(false);
    expect(plugins.state("makosh-navigation")).toBe(true);
    handle.write({ threadListPart: true });
    await sync.idle();
    expect(plugins.state("makosh-sidebar")).toBe(true);
    expect(plugins.calls.filter((call) => call !== "list")).toEqual(["disable makosh-sidebar", "enable makosh-sidebar"]);
  });

  it("does nothing when another key is written, and never re-enables a plugin the owner disabled", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true, threadListPart: true }, [
      { id: "makosh-navigation", enabled: false },
      { id: "makosh-sidebar", enabled: true },
    ]);
    handle.write({ homeRedirect: true });
    handle.write({ tileSpace: false });
    handle.write({ navigationPart: true });
    await sync.idle();
    expect(plugins.calls).toEqual([]);
  });

  it("does not call the host when the plugin already matches the new switch", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true }, [{ id: "makosh-navigation", enabled: false }, { id: "makosh-sidebar", enabled: true }]);
    handle.write({ navigationPart: false });
    await sync.idle();
    expect(plugins.calls.filter((call) => call !== "list")).toEqual([]);
  });

  it("serializes changes that arrive together and ends on the last value", async () => {
    const { handle, plugins, sync } = setup({ navigationPart: true }, both.map((p) => ({ ...p })));
    handle.write({ navigationPart: false });
    handle.write({ navigationPart: true });
    handle.write({ navigationPart: false });
    await sync.idle();
    expect(plugins.state("makosh-navigation")).toBe(false);
  });

  it("logs one line for a plugin that is not installed and calls nothing for it", async () => {
    const { handle, plugins, log, sync } = setup({ navigationPart: true }, [{ id: "makosh-sidebar", enabled: true }]);
    handle.write({ navigationPart: false });
    await sync.idle();
    expect(plugins.calls.filter((call) => call !== "list")).toEqual([]);
    expect(log.lines.filter((line) => line.includes("makosh-navigation"))).toHaveLength(1);
  });

  it("survives a refusal and logs it once, without retrying on unrelated writes", async () => {
    const { handle, plugins, log, sync } = setup({ navigationPart: true }, both.map((p) => ({ ...p })));
    plugins.failures.set("makosh-navigation", "no permission");
    handle.write({ navigationPart: false });
    await sync.idle();
    handle.write({ homeRedirect: true });
    await sync.idle();
    expect(plugins.calls.filter((call) => call === "disable makosh-navigation")).toHaveLength(1);
    const warnings = log.lines.filter((line) => line.startsWith("warn"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("makosh-navigation");
    expect(warnings[0]).toContain("no permission");
  });

  it("survives a failing inventory read", async () => {
    const handle = new FakeHandle({ navigationPart: true });
    const log = new FakeLog();
    const plugins = { list: async () => { throw new Error("inventory down"); } };
    const sync = startPartSync({ settings: handle, plugins: () => plugins as never, log });
    handle.write({ navigationPart: false });
    await expect(sync.idle()).resolves.toBeUndefined();
    expect(log.lines.filter((line) => line.startsWith("warn") && line.includes("inventory down"))).toHaveLength(1);
  });
});
