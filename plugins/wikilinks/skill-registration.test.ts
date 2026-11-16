import { test, expect } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
test("agent configuration selects the installed obsidian-at-home skill", async () => {
  const host = createFakePluginHost({ pluginId: "wikilinks", agentSkillIds: ["obsidian-at-home"] });
  try {
    await plugin(host.bb);
    const result = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(result.skills).toEqual(["obsidian-at-home"]);
  } finally { await host.harness.lifecycle.dispose(); }
});
