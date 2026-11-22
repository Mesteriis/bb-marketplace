// What travels between a Chertog window and the plugin's server: the RPC
// schemas of the workspace document and the address of the controlled frame
// page. Pure TypeScript and zod.
export {
  loadWorkspaceInputSchema,
  loadWorkspaceOutputSchema,
  saveWorkspaceInputSchema,
  saveWorkspaceOutputSchema,
  workspaceRpcSchemas,
} from "./workspace.ts";

export { LIVE_FRAME_ROUTE, liveFrameUrlPath } from "./live-frame.ts";

export { OPEN_EVENT, OPEN_OUTCOMES, isAcceptedOutcome, openRequestSchema, type OpenOutcome, type OpenRequest } from "./open.ts";
