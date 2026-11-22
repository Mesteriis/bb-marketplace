import { expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../../../server";

it("rejects foreign and missing caller identities before any account or ticket operation", async () => {
  const register = vi.fn();
  const get = vi.fn(async () => ({ vaultKey: Buffer.alloc(32, 1).toString("base64") }));
  await plugin({
    settings: { define: () => ({ get }) },
    storage: { kv: {} },
    http: { route: vi.fn() },
    rpc: { register },
  } as unknown as BbPluginApi);
  const handlers = register.mock.calls[0]![1];
  for (const name of [
    "meetings_list",
    "meeting_create",
    "call_prepare",
    "call_open_external",
    "embed_select",
    "embed_resolve",
    "embed_prepare",
    "disconnect",
  ]) {
    expect(() => handlers[name]({}, { experimental_caller: { kind: "plugin", pluginId: "chertog" } })).toThrow("только в Zoom");
    expect(() => handlers[name]({}, {})).toThrow("только в Zoom");
  }
  expect(get).toHaveBeenCalledTimes(1);
});
