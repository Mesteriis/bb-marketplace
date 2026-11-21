// Chertog on the BB server: the workspace store over the plugin's storage,
// the RPC that serves it to the windows, and the route of the controlled
// frame page.
export type { KvWorkspaceStoreDeps } from "./workspace-store.ts";
export { createKvWorkspaceStore } from "./workspace-store.ts";

export { registerWorkspaceRpc, workspaceRpcContract } from "./workspace-rpc.ts";

export { readLiveFrameFixture, registerLiveFrameRoute } from "./live-frame-route.ts";
