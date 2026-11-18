import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { TASKBOARD_MAYBE_CREATED, TASKBOARD_NOT_INSTALLED, TASKBOARD_PLUGIN_ID, TASKBOARD_UNAVAILABLE, createTaskboardTarget } from "./taskboard-target.ts";

function target(options: { plugins?: { id: string; enabled: boolean }[]; callRpc?: (args: { method: string; input?: unknown }) => unknown }) {
  const { sdk, harness } = createFakeSdk({
    pluginId: "mail",
    overrides: {
      plugins: {
        list: async () => ({ plugins: options.plugins ?? [{ id: TASKBOARD_PLUGIN_ID, enabled: true }] }),
        callRpc: async (args: { method: string; input?: unknown }) => options.callRpc?.(args),
      },
    },
  });
  return { taskboard: createTaskboardTarget(sdk), harness };
}

const BOARDS = {
  boards: [
    { id: "b_local", name: "Personal", connectionId: null, columns: [{ id: "todo" }] },
    { id: "b_jira", name: "Team", connectionId: "c_1", columns: [] },
  ],
};

describe("createTaskboardTarget", () => {
  it("lists local boards only, reading id, name and connectionId", async () => {
    const { taskboard, harness } = target({ callRpc: () => BOARDS });
    expect(await taskboard.boards()).toEqual({ boards: [{ id: "b_local", name: "Personal" }] });
    expect(harness.callsTo("plugins.callRpc")[0]![0]).toMatchObject({ pluginId: "makosh-taskboard", method: "boards_list", input: {} });
  });

  it("is unavailable when Taskboard is absent or disabled, without calling it", async () => {
    for (const plugins of [[], [{ id: TASKBOARD_PLUGIN_ID, enabled: false }], [{ id: "other", enabled: true }]]) {
      const { taskboard, harness } = target({ plugins, callRpc: () => BOARDS });
      expect(await taskboard.boards()).toEqual({ unavailable: TASKBOARD_NOT_INSTALLED });
      expect(await taskboard.create("b", "t", "d")).toEqual({ unavailable: TASKBOARD_NOT_INSTALLED });
      expect(harness.callsTo("plugins.callRpc")).toHaveLength(0);
    }
  });

  it("is unavailable when callRpc throws or answers malformed boards", async () => {
    const thrown = target({
      callRpc: () => {
        throw new experimental_PluginRpcCallError({ code: "transport_error", message: "socket closed" });
      },
    });
    expect(await thrown.taskboard.boards()).toEqual({ unavailable: TASKBOARD_UNAVAILABLE });
    for (const answer of [null, { boards: "x" }, { boards: [{ id: 1, name: "n", connectionId: null }] }, { boards: [{ id: "b", name: "n" }] }]) {
      expect(await target({ callRpc: () => answer }).taskboard.boards()).toEqual({ unavailable: TASKBOARD_UNAVAILABLE });
    }
    const listFails = createFakeSdk({ pluginId: "mail", overrides: { plugins: { list: async () => { throw new Error("offline"); } } } });
    expect(await createTaskboardTarget(listFails.sdk).boards()).toEqual({ unavailable: TASKBOARD_UNAVAILABLE });
  });

  it("creates a task with the given text and answers its id", async () => {
    const { taskboard, harness } = target({ callRpc: () => ({ task: { id: "task_7", title: "x", extra: true } }) });
    expect(await taskboard.create("b_local", "Fix the build", "From mail: Ada")).toEqual({ taskId: "task_7" });
    expect(harness.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
      pluginId: "makosh-taskboard",
      method: "task_create",
      input: { boardId: "b_local", title: "Fix the build", description: "From mail: Ada" },
    });
  });

  it("after task_create was sent, a timeout or a malformed answer is uncertain, never unavailable", async () => {
    const { taskboard } = target({
      callRpc: () => {
        throw new Error("timed out");
      },
    });
    expect(await taskboard.create("b", "t", "d")).toEqual({ uncertain: TASKBOARD_MAYBE_CREATED });
    expect(await target({ callRpc: () => ({ task: {} }) }).taskboard.create("b", "t", "d")).toEqual({ uncertain: TASKBOARD_MAYBE_CREATED });
  });

  it("maps Taskboard's refusals to their message and a call BB refused to unavailable", async () => {
    for (const code of ["not_found", "invalid", "conflict"] as const) {
      const { taskboard } = target({
        callRpc: () => {
          throw new experimental_PluginRpcCallError({ code, message: "Board not found\nsecond line" });
        },
      });
      expect(await taskboard.create("b", "t", "d")).toEqual({ refused: "Board not found second line" });
    }
    for (const error of [
      new experimental_PluginRpcCallError({ code: "unknown_method", message: "no such method" }),
      new experimental_PluginRpcCallError({ code: "forbidden", message: "no" }),
    ]) {
      const { taskboard } = target({
        callRpc: () => {
          throw error;
        },
      });
      expect(await taskboard.create("b", "t", "d")).toEqual({ unavailable: TASKBOARD_UNAVAILABLE });
    }
  });
});
