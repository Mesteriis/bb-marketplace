import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createAgentGrants } from "./src/adapters/bb/agent-grants.ts";
import { registerAgentTools } from "./src/adapters/bb/agent-tools.ts";
import { registerCli } from "./src/adapters/bb/cli.ts";
import { createEndpoints } from "./src/adapters/bb/endpoints.ts";
import { createSqliteJobStore } from "./src/adapters/bb/job-store-sqlite.ts";
import { MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { createOperations, createRpcHandlers, refusal } from "./src/adapters/bb/rpc-handlers.ts";
import { JobRunner } from "./src/core/job-runner.ts";
import { revalidate, type PlannerDeps } from "./src/core/planner.ts";
import { rpcSchemas } from "./src/core/wire/rpc.ts";

export const rpcContract = defineRpcContract(rpcSchemas);
const agentJobMigration = `
  CREATE INDEX IF NOT EXISTS jobs_agent_updated_at ON jobs (thread_id, updated_at DESC, id ASC)
    WHERE initiator_kind = 'agent';
  CREATE TABLE IF NOT EXISTS commander_owner_approvals (job_id TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS commander_record_owner_approval AFTER UPDATE OF state ON jobs
    WHEN old.awaits_owner = 1 AND new.state = 'running'
    BEGIN INSERT OR IGNORE INTO commander_owner_approvals VALUES (new.id); END;
  CREATE TRIGGER IF NOT EXISTS commander_forget_owner_approval AFTER DELETE ON jobs
    BEGIN DELETE FROM commander_owner_approvals WHERE job_id = old.id; END;
`;

export default function activate(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS, agentJobMigration]);
  const store = createSqliteJobStore(db);
  const ownerApproval = db.prepare("SELECT 1 FROM commander_owner_approvals WHERE job_id = ?").pluck();
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
  const runner = new JobRunner({
    ...planner,
    store,
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
    hasOwnerApproval: (id) => ownerApproval.get(id) === 1,
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
