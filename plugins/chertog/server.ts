// Chertog — BB backend entry.
//
// Composition root for the BB server: the declared settings, the workspace
// RPC over the plugin's storage, the route of the controlled frame page, and
// the check that keeps the Navigation and Sidebar plugins in step with their switches.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerWindowsRpc } from "./src/adapters/bb/server/windows-rpc.ts";
import {
  createKvWorkspaceStore,
  readLiveFrameFixture,
  registerLiveFrameRoute,
  registerWorkspaceRpc,
  workspaceRpcContract,
} from "./src/adapters/bb/server/index.ts";
import { startPartSync } from "./src/adapters/bb/server/parts-sync.ts";
import { registerChertogSettings } from "./src/adapters/bb/server/settings.ts";

/** The contract a window types its calls with: `useRpc<typeof rpcContract>()`. */
export const rpcContract = workspaceRpcContract;

export default function plugin(bb: BbPluginApi): void {
  const settings = registerChertogSettings(bb.settings);
  const store = createKvWorkspaceStore({ kv: bb.storage.kv, now: () => new Date(), log: bb.log });
  registerWorkspaceRpc(bb.rpc, store);
  registerWindowsRpc(bb);
  registerLiveFrameRoute(bb, readLiveFrameFixture(import.meta.url));
  // Navigation and the thread list still live in other plugins: their switches enable and disable them.
  startPartSync({ settings, plugins: () => bb.sdk.plugins, log: bb.log });
}
