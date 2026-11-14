// Makosh Mail — BB backend entry.
//
// This file is the BB adapter's composition root: it builds the BB
// implementations of the core's ports and exposes the core over BB RPC.
// Mail logic belongs in src/core, which must stay free of host imports.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createKvAccountRepository } from "./src/adapters/bb/kv-account-repository.ts";
import { getMailOverview, mailOverviewSchema } from "./src/core/index.ts";

// Both schemas run at the wire boundary; app.tsx imports only the type.
export const rpcContract = defineRpcContract({
  overview_get: {
    input: z.null(),
    output: mailOverviewSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const accounts = createKvAccountRepository(bb.storage.kv);

  bb.rpc.register(rpcContract, {
    overview_get: () => getMailOverview({ accounts }),
  });
}
