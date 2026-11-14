import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type FakeHost = ReturnType<typeof createFakePluginHost>;

let host: FakeHost | undefined;

async function loadPlugin(): Promise<FakeHost> {
  host = createFakePluginHost({ pluginId: "makosh-mail" });
  await plugin(host.bb);
  return host;
}

afterEach(async () => {
  await host?.harness.lifecycle.dispose();
  host = undefined;
});

describe("overview_get", () => {
  it("returns an empty overview on a fresh install", async () => {
    const { harness } = await loadPlugin();

    await expect(harness.behavior.callRpc("overview_get", null)).resolves.toEqual({
      accounts: [],
    });
  });

  it("returns the stored accounts ordered by address", async () => {
    const { bb, harness } = await loadPlugin();
    await bb.storage.kv.set("accounts", [
      { id: "2", address: "zoe@example.org" },
      { id: "1", address: "anna@example.org", displayName: "Anna" },
    ]);

    await expect(harness.behavior.callRpc("overview_get", null)).resolves.toEqual({
      accounts: [
        { id: "1", address: "anna@example.org", displayName: "Anna" },
        { id: "2", address: "zoe@example.org" },
      ],
    });
  });

  it("rejects stored account data that does not match the schema", async () => {
    const { bb, harness } = await loadPlugin();
    await bb.storage.kv.set("accounts", [{ id: "", address: 42 }]);

    await expect(harness.behavior.callRpc("overview_get", null)).rejects.toThrow();
  });
});
