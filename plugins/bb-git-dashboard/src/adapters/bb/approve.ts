import type { BbPluginApi } from "@get-bb/plugin-sdk";

export async function approve(bb:BbPluginApi, threadId:string, operationId:string, title:string, lines:string[], signal:AbortSignal) {
  const result = await bb.ui.requestInput({
    threadId, rendererId:"git-confirm", title,
    payload:{operationId,lines}, timeoutMs:4*60_000,
    describeSubmission:() => ({title:"Git operation approved"}),
  },{signal});
  return result.outcome === "submitted" && result.value === operationId && !signal.aborted;
}
