// S16
import { EDIT_SNAPSHOT_ENDPOINT } from "./src/core/edit-session.ts";
import { createEditHostClient } from "./src/adapters/bb/edit-host-client.ts";
import { createEditOperations } from "./src/adapters/bb/edit-operations.ts";
import { createEditStore } from "./src/adapters/bb/edit-store.ts";
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createAgentGrants } from "./src/adapters/bb/agent-grants.ts";
import { registerAgentTools } from "./src/adapters/bb/agent-tools.ts";
import { registerCli } from "./src/adapters/bb/cli.ts";
import { createArchiveRuntime, type ArchiveRuntime } from "./src/adapters/bb/archive-runtime.ts";
import { createEndpoints } from "./src/adapters/bb/endpoints.ts";
import { createSqliteJobStore } from "./src/adapters/bb/job-store-sqlite.ts";
import { MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { createOperations, createRpcHandlers, refusal } from "./src/adapters/bb/rpc-handlers.ts";
import type { JobStore } from "./src/core/job-store.ts";
import { JobRunner } from "./src/core/job-runner.ts";
import { installNativeSha256 } from "./src/adapters/bb/native-sha256.ts";
import { revalidate, type PlannerDeps } from "./src/core/planner.ts";
import { createSqliteScanStore } from "./src/adapters/bb/scan-store-sqlite.ts";
import { ScanRunner } from "./src/core/scan-job.ts";
import { rpcSchemas } from "./src/core/wire/rpc.ts";

export const rpcContract = defineRpcContract(rpcSchemas);
export default function activate(bb: BbPluginApi) {
  installNativeSha256();
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // S16: recover durable edit sessions and receive queue receipts in the same database.
  const editStore = createEditStore(db);
  const store = createSqliteJobStore(db, editStore);
  const scanStore = createSqliteScanStore(db);
  const scans = new ScanRunner(randomUUID, scanStore);
  // S14: set below; null where the helper does not exist (anything but macOS arm64) or failed to prepare.
  let archives: ArchiveRuntime | null = null;
  const endpoints = createEndpoints(bb, () => archives?.manager ?? null);
  const kv = bb.storage.kv;
  const grants = createAgentGrants(kv);
  const planner: PlannerDeps = {
    provider: endpoints.provider,
    protectedPathsFor: endpoints.protectedPathsFor,
    limits: { maxItems: 100_000, maxDepth: 64 },
    now: () => new Date(),
    uuid: randomUUID,
  };
  const publish = (kind: "job" | "dir" | "endpoints" | "archive-password", id: string) => bb.realtime.publish("commander", { kind, id });
  if (process.platform === "darwin" && process.arch === "arm64") {
    archives = createArchiveRuntime({
      bb, db, jobs: store, kv, sourceProvider: endpoints.provider,
      publishPassword: (id) => publish("archive-password", id),
    });
  }
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
  // S16: the snapshot provider exists only inside the queue and editor.
  const editHost = createEditHostClient(bb);
  const editProvider = editHost.provider();
  const queuePlanner = {
    ...planner,
    provider: (endpoint: string) => endpoint === EDIT_SNAPSHOT_ENDPOINT ? editProvider : planner.provider(endpoint),
  };
  const editShutdown = new AbortController();
  let editSweep: ReturnType<typeof setInterval> | undefined;
  const sweepEdits = () => void edit.sweep(editShutdown.signal).catch(() => {
    if (!disposed) bb.log.error("Commander edit cleanup failed");
  });
  const runner = new JobRunner({
    ...queuePlanner,
    store: runnerStore,
    revalidate: (plan, signal) => revalidate(plan, queuePlanner, signal),
    onEvent: ({ jobId, kind }) => {
      if (disposed) return;
      publish("job", jobId);
      if (kind !== "state") return;
      void store.get(jobId).then((job) => {
        if (job && ["completed", "failed", "cancelled"].includes(job.state)) void archives?.registry.releaseForJob(job).catch(() => {});
        if (disposed || !job || !["completed", "failed", "cancelled", "unknown"].includes(job.state)) return;
        const { kind, sourceEndpoint, targetEndpoint } = job.plan;
        // S16: release a writeback snapshot after its last queue reference.
        if (sourceEndpoint === EDIT_SNAPSHOT_ENDPOINT) sweepEdits();
        const changed = new Set([targetEndpoint, kind === "copy" ? null : sourceEndpoint]);
        for (const id of changed) if (id !== null) publish("dir", id);
      }).catch(() => {});
    },
  });

  // S16
  const edit = createEditOperations({
    host: editHost, store: editStore, jobs: store, planner: queuePlanner, prepare: endpoints.prepare,
    submit: (plan, request) => runner.submit(plan, { awaitsOwner: false, editWriteBack: request }),
    failure: () => { if (!disposed) bb.log.error("Commander edit cleanup failed"); },
  });
  let recovery: "starting" | "ready" | "failed" = "starting";
  const ops = createOperations({
    endpoints, runner, store, planner, grants, kv, publish: (kind, id) => publish(kind, id),
    scans,
    get archives() {
      return archives ?? undefined;
    },
    // S16
    edit,
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
        scanStore.interruptRunning();
        try {
          await archives?.init(signal);
        } catch {
          // Archives stay off; everything else keeps working.
          archives = null;
          try {
            bb.log.warn("Commander archives are unavailable");
          } catch {
            // Logging must not fail the recovery.
          }
        }
        await ops.prepareRecovery(signal);
        await runner.recover();
        if (signal.aborted || disposed) return;
        recovery = "ready";
        // S16: cleanup never blocks recovery or the rest of Commander.
        sweepEdits();
        editSweep = setInterval(sweepEdits, 30_000);
        editSweep.unref();
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
    // S16
    clearInterval(editSweep);
    editShutdown.abort();
    await edit.shutdown();
    await scans.shutdown();
    await runner.shutdown();
    await archives?.dispose();
    await endpoints.close();
  });

  bb.rpc.register(rpcContract, createRpcHandlers(ops));
  registerAgentTools(bb.agents, ops);
  registerCli(bb.cli, ops);
}
