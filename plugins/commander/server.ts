import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createAgentGrants } from "./src/adapters/bb/agent-grants.ts";
import { registerAgentTools } from "./src/adapters/bb/agent-tools.ts";
import { registerCli } from "./src/adapters/bb/cli.ts";
import { createEndpoints } from "./src/adapters/bb/endpoints.ts";
import { createSqliteJobStore } from "./src/adapters/bb/job-store-sqlite.ts";
import { MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { createOperations, createRpcHandlers, refusal } from "./src/adapters/bb/rpc-handlers.ts";
import type { JobStore } from "./src/core/job-store.ts";
import { JobRunner } from "./src/core/job-runner.ts";
import { revalidate, type PlannerDeps } from "./src/core/planner.ts";
import { rpcSchemas } from "./src/core/wire/rpc.ts";

export const rpcContract = defineRpcContract(rpcSchemas);
export default function activate(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createSqliteJobStore(db);
  const endpoints = createEndpoints(bb);
  const kv = bb.storage.kv;
  const grants = createAgentGrants(kv);
  const planner: PlannerDeps = {
    provider: endpoints.provider,
    protectedPathsFor: endpoints.protectedPathsFor,
    limits: { maxItems: 100_000, maxDepth: 64 },
    now: () => new Date(),
    uuid: randomUUID,
  };
  const publish = (kind: "job" | "dir" | "endpoints", id: string) => bb.realtime.publish("commander", { kind, id });
  let disposed = false;
  const live = new Set<string>();
  const runnerStore: JobStore = {
    ...store,
    async update(id, patch, expected) {
      const changed = await store.update(id, patch, expected);
      if (changed && patch.state) {
        if (patch.state === "running" || patch.state === "awaiting_decision") live.add(id);
        else if (patch.state !== "cancel_requested") live.delete(id);
      }
      return changed;
    },
  };
  const runner = new JobRunner({
    ...planner,
    store: runnerStore,
    revalidate: (plan, signal) => revalidate(plan, planner, signal),
    onEvent: ({ jobId, kind }) => {
      if (disposed) return;
      publish("job", jobId);
      if (kind !== "state") return;
      void store.get(jobId).then((job) => {
        if (disposed || !job || !["completed", "failed", "cancelled", "unknown"].includes(job.state)) return;
        const { kind, sourceEndpoint, targetEndpoint } = job.plan;
        const changed = new Set([targetEndpoint, kind === "copy" ? null : sourceEndpoint]);
        for (const id of changed) if (id !== null) publish("dir", id);
      }).catch(() => {});
    },
  });

  let recovery: "starting" | "ready" | "failed" = "starting";
  const ops = createOperations({
    endpoints, runner, store, planner, grants, kv, publish,
    isManaged: (id) => live.has(id),
    async ready() {
      if (recovery === "failed") throw refusal("conflict", "Commander recovery failed");
      if (disposed || recovery !== "ready") throw refusal("conflict", "Commander jobs are being recovered");
    },
  });

  bb.background.service("jobs", {
    async start(signal) {
      if (signal.aborted) return;
      try {
        await ops.prepareRecovery(signal);
        await runner.recover();
        if (signal.aborted || disposed) return;
        recovery = "ready";
      } catch {
        if (signal.aborted || disposed) return;
        recovery = "failed";
        bb.log.error("Commander recovery failed");
        throw new Error("Commander recovery failed");
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    },
  });
  bb.onDispose(async () => {
    disposed = true;
    await runner.shutdown();
    await endpoints.close();
  });

  bb.rpc.register(rpcContract, createRpcHandlers(ops));
  registerAgentTools(bb.agents, ops);
  registerCli(bb.cli, ops);
}
