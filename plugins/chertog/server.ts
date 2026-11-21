// Chertog — BB backend entry.
//
// Composition root for the BB server: the workspace RPC over the plugin's
// storage, and the route of the controlled frame page.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createKvWorkspaceStore,
  readLiveFrameFixture,
  registerLiveFrameRoute,
  registerWorkspaceRpc,
  workspaceRpcContract,
} from "./src/adapters/bb/server/index.ts";

/** The contract a window types its calls with: `useRpc<typeof rpcContract>()`. */
export const rpcContract = workspaceRpcContract;

export default function plugin(bb: BbPluginApi): void {
  const store = createKvWorkspaceStore({ kv: bb.storage.kv, now: () => new Date(), log: bb.log });
  registerWorkspaceRpc(bb.rpc, store);
  registerLiveFrameRoute(bb, readLiveFrameFixture(import.meta.url));
}
