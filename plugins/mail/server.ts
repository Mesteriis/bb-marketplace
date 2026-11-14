// Makosh Mail — BB backend entry.
//
// This file is the BB adapter's composition root: it builds the BB
// implementations of the core's ports and exposes the core over BB RPC.
// Mail logic belongs in src/core, which must stay free of host imports.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcSchemas } from "./src/core/index.ts";

// bb.rpc.register needs a handler for every method of the contract, so this
// stub exposes only status_get until the other handlers exist.
export const rpcContract = defineRpcContract({
  status_get: rpcSchemas.status_get,
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    status_get: () => ({
      vaultReady: false,
      agentTools: false,
      accounts: [],
      unreadCount: 0,
    }),
  });
}
