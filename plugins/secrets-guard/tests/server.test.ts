import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/adapters/bb/server.ts";

let dir: string;
let file: string;
let children: Record<string, string[]>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "guard-server-"));
  file = join(dir, "marker.json");
  children = { thr_a: ["thr_b"] };
  // Only the clock is faked: 1000 seconds since the epoch.
  vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function load(stateFile: string | null) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "makosh-secrets-guard",
    settings: stateFile === null ? {} : { stateFile },
    sdk: {
      threads: {
        list: async (args: { parentThreadId?: string } = {}) =>
          (children[args.parentThreadId ?? ""] ?? []).map((id) => makeThreadResponse({ id })),
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, environmentId: threadId === "thr_remote" ? "env_remote" : "env_here" }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          hostId: environmentId === "env_remote" ? "host_far" : "host_here",
        }),
      },
      system: { config: async () => ({ primaryHostId: "host_here" }) },
    } as never,
  });
  await plugin(bb);
  return harness;
}

const marker = async () => JSON.parse(await readFile(file, "utf8")) as unknown;

describe("without a marker location", () => {
  it("loads, reports the missing setting and keeps the guard closed", async () => {
    const harness = await load(null);
    expect(await harness.behavior.callRpc("state", { threadId: "thr_a" })).toEqual({
      configured: false,
      local: true,
      effective: null,
    });
    await expect(
      harness.behavior.callRpc("open", { threadId: "thr_a", scope: "thread", minutes: 10 }),
    ).rejects.toMatchObject({ code: "conflict", message: "Укажите файл отметки в настройках плагина" });
    await harness.lifecycle.dispose();
  });
  it("becomes usable when the owner sets the path", async () => {
    const harness = await load(null);
    await harness.behavior.setSettings({ stateFile: file });
    expect(await harness.behavior.callRpc("open", { threadId: "thr_a", scope: "thread", minutes: 10 })).toEqual({
      configured: true,
      local: true,
      effective: { scope: "thread", until: 1600, rootThreadId: "thr_a" },
    });
    await harness.lifecycle.dispose();
  });
});

describe("what the plugin exposes", () => {
  it("registers three rpc methods and nothing an agent could open the guard with", async () => {
    const harness = await load(file);
    const registrations = harness.inspection.registrations;
    expect([...registrations.rpcMethods].sort()).toEqual(["close", "open", "state"]);
    expect(registrations.cli).toBeNull();
    expect(registrations.agentTools).toEqual([]);
    expect(registrations.httpRoutes).toEqual([]);
    expect(registrations.websocketRoutes).toEqual([]);
    expect(registrations.agentConfigurationProvider).toBeNull();
    expect(registrations.instructionProvider).toBeNull();
    await harness.lifecycle.dispose();
  });
});

describe("rpc", () => {
  it("opens a thread with its subthreads and writes the marker", async () => {
    const harness = await load(file);
    await harness.behavior.callRpc("open", { threadId: "thr_a", scope: "tree", minutes: 10 });
    expect(await marker()).toEqual({
      threads: {
        thr_a: { until: 1600, root: "thr_a", tree: true },
        thr_b: { until: 1600, root: "thr_a", tree: true },
      },
    });
    await harness.lifecycle.dispose();
  });
  it("rejects a term outside 10, 30 and 60 minutes", async () => {
    const harness = await load(file);
    await expect(
      harness.behavior.callRpc("open", { threadId: "thr_a", scope: "global", minutes: 600 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await harness.lifecycle.dispose();
  });
  it("refuses a thread that runs on another machine", async () => {
    const harness = await load(file);
    expect(await harness.behavior.callRpc("state", { threadId: "thr_remote" })).toEqual({
      configured: true,
      local: false,
      effective: null,
    });
    await expect(
      harness.behavior.callRpc("open", { threadId: "thr_remote", scope: "global", minutes: 10 }),
    ).rejects.toMatchObject({ code: "forbidden", message: "Охрана настраивается только на этом Mac" });
    await harness.lifecycle.dispose();
  });
  it("reports a path that cannot be written as a conflict and stays closed", async () => {
    const harness = await load(join(dir, "missing", "marker.json"));
    await expect(
      harness.behavior.callRpc("open", { threadId: "thr_a", scope: "thread", minutes: 10 }),
    ).rejects.toMatchObject({ code: "conflict", message: "Файл отметки недоступен для записи" });
    expect(await harness.behavior.callRpc("state", { threadId: "thr_a" })).toMatchObject({ effective: null });
    await harness.lifecycle.dispose();
  });
  it("closes what the phrase hook opened globally", async () => {
    await writeFile(file, '{"until":4600}');
    const harness = await load(file);
    expect(await harness.behavior.callRpc("close", { threadId: "thr_a" })).toMatchObject({ effective: null });
    expect(await marker()).toEqual({ threads: {} });
    await harness.lifecycle.dispose();
  });
});

describe("thread events", () => {
  it("opens a subthread created after the button was pressed", async () => {
    const harness = await load(file);
    await harness.behavior.callRpc("open", { threadId: "thr_a", scope: "tree", minutes: 10 });
    children.thr_a = ["thr_b", "thr_c"];
    await harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_c" }) });
    await vi.waitFor(async () => {
      expect(await marker()).toEqual({
        threads: {
          thr_a: { until: 1600, root: "thr_a", tree: true },
          thr_b: { until: 1600, root: "thr_a", tree: true },
          thr_c: { until: 1600, root: "thr_a", tree: true },
        },
      });
    });
    await harness.lifecycle.dispose();
  });
  it("closes a subthread moved out of the tree", async () => {
    const harness = await load(file);
    await harness.behavior.callRpc("open", { threadId: "thr_a", scope: "tree", minutes: 10 });
    children.thr_a = [];
    await harness.behavior.emitThreadEvent("experimental_thread.parentChanged", {
      thread: makeThreadResponse({ id: "thr_b" }),
      previousParentThreadId: "thr_a",
    });
    await vi.waitFor(async () => {
      expect(await marker()).toEqual({ threads: { thr_a: { until: 1600, root: "thr_a", tree: true } } });
    });
    await harness.lifecycle.dispose();
  });
  it("survives a thread listing that fails", async () => {
    const harness = await load(file);
    await harness.behavior.callRpc("open", { threadId: "thr_a", scope: "tree", minutes: 10 });
    harness.sdk.stub("threads.list", async () => {
      throw new Error("server is busy");
    });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_b" }) });
    await vi.waitFor(() => {
      expect(harness.logEntries.some((entry) => entry.level === "warn")).toBe(true);
    });
    expect(await harness.behavior.callRpc("state", { threadId: "thr_b" })).toMatchObject({
      effective: { scope: "tree", until: 1600, rootThreadId: "thr_a" },
    });
    await harness.lifecycle.dispose();
  });
});
