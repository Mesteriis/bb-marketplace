import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { expect, test } from "vitest";
import activate from "../server.ts";
import { agentFindChatsTool, agentFindTopicsTool, agentHistoryTool, agentReadTool } from "../src/adapters/bb/agent-read.ts";
import { agentSendTool } from "../src/adapters/bb/agent-send.ts";

const context: PluginAgentConfigurationContext = {
  pluginMetadata: {},
  thread: { id: "fixture", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "fixture", kind: "personal", name: "Fixture", gitRemoteUrl: null },
  environment: { id: "fixture", name: null, path: null, branchName: null, workspaceProvisionType: null },
  host: { id: "fixture", name: "Fixture" },
  provider: { id: "fixture", model: "fixture", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId: null },
};

test("keeps history tools available to existing threads while checking permissions on each call", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram", settings: { agentSend: true, agentReadHistory: true } });
  try {
    await activate(bb);
    async function offered() {
      return (await harness.behavior.resolveAgentConfiguration(context)).tools.map(({ name }) => name);
    }
    const historyTools = [agentFindChatsTool, agentFindTopicsTool, agentHistoryTool];
    await expect(offered()).resolves.toEqual([...historyTools, agentSendTool]);
    await harness.behavior.setSettings({ agentReadOwnNotes: true });
    await expect(offered()).resolves.toEqual([...historyTools, agentSendTool]);
    await harness.behavior.setSettings({ agentSend: false });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentSendTool, { text: "Fixture" })).resolves.toContain("disabled");
    await harness.behavior.setSettings({ agentReadOwnNotes: false });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentReadTool, {})).resolves.toContain("disabled");
    await harness.behavior.setSettings({ agentHistoryChats: JSON.stringify({ accountId: "42", chatIds: ["-42"] }) });
    await expect(offered()).resolves.toEqual(historyTools);
    await harness.behavior.setSettings({ agentHistoryChats: "" });
    await expect(offered()).resolves.toEqual(historyTools);
    await expect(harness.behavior.callAgentTool(agentFindChatsTool, {
      query: "Fixture", dateFrom: "2026-11-02", dateTo: "2026-11-15",
    })).resolves.toContain("connect the account");
  } finally { await harness.lifecycle.dispose(); }
});

test("other plugins cannot use the manual RPC to bypass the agent review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  try {
    await activate(bb);
    const caller = { experimental_caller: { kind: "plugin", pluginId: "fixture-plugin" } } as const;
    await expect(harness.behavior.callRpc("setAgentAccess", { capability: "send", enabled: true }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("history", { id: "42" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("send", { id: "42", text: "Fixture" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("deleteMessage", { id: "42", messageId: "25", scope: "everyone" }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("setChatAgentAccess", { id: "42", enabled: true }, caller))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(harness.behavior.callRpc("agentAccess", null)).resolves.toEqual({ read: false, send: false, history: false });
  } finally { await harness.lifecycle.dispose(); }
});
