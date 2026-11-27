import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { ciAgent } from "./ci-agent.ts";
import { ciService, type CiDeps } from "./ci-service.ts";

type Caller = {experimental_caller: {kind: string}};

/** RPC handlers of the CI/CD section; only the app calls them. */
export function ciHandlers(bb: BbPluginApi, deps: CiDeps, changed: (copyId: string) => void) {
  const service = ciService(deps);
  const agent = ciAgent(bb, service, changed);
  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
  };
  return {
    ciRuns: handle(({copyId, filter, page}: {copyId: string; filter: "active" | "failed" | "all"; page: number}) => service.runs(copyId, filter, page)),
    ciRun: handle(({copyId, runId}: {copyId: string; runId: string}) => service.run(copyId, runId)),
    ciLog: handle(({copyId, runId, jobId}: {copyId: string; runId: string; jobId: string}) => service.log(copyId, runId, jobId)),
    ciWorkflows: handle(({copyId}: {copyId: string}) => service.workflows(copyId)),
    ciForm: handle(({copyId, workflowId, ref}: {copyId: string; workflowId: string; ref: string}) => service.form(copyId, workflowId, ref)),
    ciPrepare: handle(({copyId, action}: {copyId: string; action: Parameters<typeof service.prepare>[1]}) => service.prepare(copyId, action)),
    ciConfirm: handle(async ({previewId}: {previewId: string}) => {
      const result = await service.confirm(previewId);
      return result;
    }),
    ciThreads: handle(({copyId}: {copyId: string}) => agent.threads(copyId)),
    ciAsk: handle(({copyId, runId, jobId}: {copyId: string; runId: string; jobId: string | null}) => agent.ask(copyId, runId, jobId)),
    ciSend: handle(({copyId, runId, jobId, threadIds}: {copyId: string; runId: string; jobId: string | null; threadIds: string[]}) =>
      agent.send(copyId, runId, jobId, threadIds)),
    ciSubscribe: handle(({copyId, threadIds}: {copyId: string; threadIds: string[]}) => agent.subscribe(copyId, threadIds)),
  };
}
export type { Copy };
