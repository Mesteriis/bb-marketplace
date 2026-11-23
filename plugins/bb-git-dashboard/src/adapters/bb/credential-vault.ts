import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pluginId = "makosh-credential-vault";
const secretResult = z.object({secret:z.string().min(1).max(131072).nullable()});
const storedResult = z.object({stored:z.boolean()});

export function credentialVault(plugins:BbPluginApi["sdk"]["plugins"]) {
  function timeBound(signal?:AbortSignal) {
    const deadline = AbortSignal.timeout(8_000);
    return signal ? AbortSignal.any([signal,deadline]) : deadline;
  }
  return {
    async enabled(signal?:AbortSignal) {
      const {plugins:installed} = await plugins.list({signal:timeBound(signal)});
      return installed.some(plugin => plugin.id === pluginId && plugin.enabled);
    },
    async get(ref:string,signal?:AbortSignal) {
      const {secret} = await plugins.callRpc({
        pluginId, method:"experimental_get", input:{ref}, outputSchema:secretResult, signal:timeBound(signal),
      });
      return secret;
    },
    async putIfAbsent(ref:string,secret:string,signal?:AbortSignal) {
      await plugins.callRpc({
        pluginId, method:"experimental_put_if_absent", input:{ref,secret}, outputSchema:storedResult, signal:timeBound(signal),
      });
    },
  };
}
