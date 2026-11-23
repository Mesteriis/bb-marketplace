import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { branch, path, revision } from "../../core/git.ts";
import { failureFor, id, type Copy } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";
import { approve } from "./approve.ts";

const schema = z.object({
  operationId:id, title:z.string().trim().min(1).max(150), prompt:z.string().trim().min(1).max(8000),
  target:z.discriminatedUnion("kind", [
    z.object({kind:z.literal("create"),branch,base:revision,destination:path}),
    z.object({kind:z.literal("attach"),root:path}),
  ]),
});
type Binding = {copy:Copy; permission:"none"|"read"|"write"};
type Result =
  | {state:"pending"|"unknown",copy?:Copy}
  | {state:"completed",copy:Copy,threadId:string,environmentId:string|null};

export function registerAgentWork(bb:BbPluginApi, context:(threadId:string)=>Promise<Binding>,
  save:(hostId:string,root:string,identity:string)=>Promise<Copy>) {
  const host = bb.hosts.experimental_client({contract:hostContract});
  const kv = bb.storage.kv;
  const running = new Set<string>();
  bb.agents.registerTool({
    name:"git_dashboard_start_work",
    description:"Request approval to start a BB agent in a new or existing linked worktree of this repository. Reuse the same operation key for status.",
    parameters:schema,
    async execute(input,{threadId,signal}) {
      const fail = (code:string) => JSON.stringify(failureFor(undefined,code,input.operationId));
      const key = "agent-work/" + threadId + "/" + input.operationId;
      if (running.has(key)) return JSON.stringify({state:"pending",operationId:input.operationId});
      running.add(key);
      try {
        const current = await context(threadId);
        if (current.permission !== "write") return fail("ACCESS_DENIED");
        const previous = await kv.get<Result>(key);
        if (previous) {
          return JSON.stringify({...previous,state:previous.state === "pending" ? "unknown" : previous.state,operationId:input.operationId});
        }
        const selected = input.target;
        const copy = current.copy;
        const destination = selected.kind === "create" ? selected.destination : selected.root;
        if (!(await approve(bb,threadId,input.operationId,"Start agent in Git worktree",[
          copy.hostId + " · " + copy.root, destination, input.title, input.prompt,
          ...(selected.kind === "create" ? [selected.branch + " @ " + selected.base] : []),
        ],signal))) return fail("CANCELLED");
        const latest = await context(threadId);
        if (latest.copy.id !== copy.id || latest.permission !== "write") return fail("ACCESS_DENIED");
        const source = await bb.sdk.threads.get({threadId});
        await kv.set(key,{state:"pending"} satisfies Result);
        let attached:Copy|undefined;
        try {
          const result = selected.kind === "create"
            ? await host.call("git",{root:copy.root,identity:copy.identity,action:{kind:"worktree",branch:selected.branch,base:selected.base,destination}},{hostId:copy.hostId,signal})
            : await host.call("git",{root:copy.root,identity:copy.identity,action:{kind:"worktrees"}},{hostId:copy.hostId,signal});
          if (!result.ok) {
            if (!["GIT_RESULT_UNKNOWN","GIT_PROCESS_UNAVAILABLE"].includes(result.code)) await kv.delete(key);
            return JSON.stringify({...result,operationId:input.operationId});
          }
          if (result.value.text === "BRANCH_OCCUPIED") {
            await kv.delete(key);
            return JSON.stringify({ok:false,code:"BRANCH_OCCUPIED",existing:result.value.worktrees?.[0],operationId:input.operationId});
          }
          const candidate = await host.call("validate",{root:destination},{hostId:copy.hostId,signal});
          if (!candidate.ok || !result.value.worktrees?.some(tree => tree.path === candidate.root && candidate.root !== copy.root)) {
            if (selected.kind === "attach") await kv.delete(key);
            return fail(selected.kind === "attach" ? "INVALID_WORKTREE" : "OUTCOME_UNKNOWN");
          }
          attached = await save(copy.hostId,candidate.root,candidate.identity);
          await kv.set(key,{state:"pending",copy:attached} satisfies Result);
          const spawned = await bb.sdk.threads.spawn({
            parentThreadId:threadId,projectId:source.projectId,providerId:source.providerId,
            title:input.title,prompt:input.prompt,
            environment:{type:"host",hostId:copy.hostId,workspace:{type:"unmanaged",path:attached.root}},
          });
          const record = spawned as {threadId?:string;id?:string;environmentId?:string|null};
          const child = record.threadId ?? record.id;
          if (!child) return fail("OUTCOME_UNKNOWN");
          const resultValue:Result = {state:"completed",copy:attached,threadId:child,environmentId:record.environmentId ?? null};
          await kv.set(key,resultValue);
          return JSON.stringify({...resultValue,operationId:input.operationId});
        } catch {
          await kv.set(key,{state:"unknown",...(attached ? {copy:attached} : {})} satisfies Result);
          return fail("OUTCOME_UNKNOWN");
        }
      } catch (error) { return JSON.stringify(failureFor(error,"HOST_UNAVAILABLE",input.operationId)); }
      finally { running.delete(key); }
    },
  });
}
