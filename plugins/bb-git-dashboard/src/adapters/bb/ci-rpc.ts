import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { ciAgent } from "./ci-agent.ts";
import { ciService, type CiDeps } from "./ci-service.ts";

type Caller = {experimental_caller: {kind: string}};

/** RPC handlers of the CI/CD section, which only the app calls, and the service they share with the CLI. */
export function ciHandlers(bb: BbPluginApi, deps: CiDeps, changed: (copyId: string) => void) {
  const settings = bb.settings.define({
    ciFallbackProject: {type: "project", label: "CI/CD: project for investigations of repositories without a BB project",
      description: "Ask agent starts its thread here, and Send and failure notifications offer this project's threads."},
    ciAnalysisModel: {type: "string", label: "CI/CD: model for failure investigations",
      description: "Empty uses the project's default model. Ask agent with another model opens the composer instead.", default: ""},
  });
  const service = ciService(deps);
  const agent = ciAgent(bb, service, changed, async () => {
    const {ciFallbackProject, ciAnalysisModel} = await settings.get();
    return {fallbackProject: ciFallbackProject, model: ciAnalysisModel};
  });
  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
  };
  const handlers = {
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
    ciSend: handle(({copyId, runId, jobId, threadIds, note, includeLogs}: {copyId: string; runId: string; jobId: string | null; threadIds: string[];
      note?: string; includeLogs?: boolean}) => agent.send(copyId, runId, jobId, threadIds, {note, includeLogs})),
    ciCompose: handle(({copyId, runId, jobId}: {copyId: string; runId: string; jobId: string | null}) => agent.compose(copyId, runId, jobId)),
    ciOverview: handle(async () => service.overview(await deps.copies?.() ?? [])),
    ciSubscribe: handle(({copyId, threadIds}: {copyId: string; threadIds: string[]}) => agent.subscribe(copyId, threadIds)),
  };
  return {handlers, service};
}
export type { Copy };
