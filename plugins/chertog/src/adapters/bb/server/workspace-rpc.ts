// The workspace RPC of the plugin: the wire schemas as a BB contract, and the
// handlers that pass each call to the store.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpc, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { workspaceRpcSchemas } from "../../../core/wire/index.ts";
import type { WorkspaceDocument, WorkspaceStore } from "../../../core/workspace/index.ts";

/** Served at POST /api/v1/plugins/<id>/rpc/<method>; a window calls it with `useRpc<typeof workspaceRpcContract>()`. */
export const workspaceRpcContract = defineRpcContract(workspaceRpcSchemas);

export function registerWorkspaceRpc(rpc: Pick<PluginRpc, "register">, store: WorkspaceStore): void {
  const handlers: PluginRpcHandlers<typeof workspaceRpcContract> = {
    load_workspace: () => store.load(),
    // The wire lets any value through as the document; the store checks it and answers `rejected`.
    save_workspace: ({ document, expectedRevision }) => store.save(document as WorkspaceDocument, expectedRevision),
  };
  rpc.register(workspaceRpcContract, handlers);
}
