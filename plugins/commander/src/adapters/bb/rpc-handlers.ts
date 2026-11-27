import { createHash } from "node:crypto";
import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext, type PluginKvStorage } from "@get-bb/plugin-sdk";
import { checksum, compareDirs, compareFiles, estimateRead, scanDir, scanFile } from "../../core/compare.ts";
import { CommanderError, isCommanderError } from "../../core/errors.ts";
import type { JobRunner } from "../../core/job-runner.ts";
import type { AgentJobStore } from "../../core/job-store.ts";
import type { Entry, Initiator, JobState, OperationJob, OperationPlan, ResourceRef } from "../../core/model.ts";
import type { ScanContext, ScanRunner } from "../../core/scan-job.ts";
import { parent } from "../../core/path.ts";
import { authorize, REQUIRED } from "../../core/permissions.ts";
import { buildPlan, revalidate, type PlannerDeps } from "../../core/planner.ts";
import { UiState, rpcSchemas, type AgentGrant, type DamagedJob, type GrantKey, type RpcInput, type ScanResult } from "../../core/wire/rpc.ts";
import { SFTP_REFUSALS, SftpRefusal } from "../../core/wire/remote-hub-sftp.ts";
import { covers, type createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";
import { scanJobView } from "./scan-store-sqlite.ts";

const owner = { kind: "owner" } as const;
const stateKey = (threadId?: string) => threadId === undefined ? "ui-state" : "ui-state:thread:" + threadId;
const maxPlanBytes = 16 * 1024 * 1024;
const maxPlans = 128;
const maxAgentPlanBytes = 4 * 1024 * 1024;
const maxThreadPlans = 32;
const maxAgentPlanItems = 10_000;
const maxThreadApprovals = 16;
const maxApprovals = 256;
const lifetime = 30 * 60 * 1000;
const activeStates = ["pending", "running", "awaiting_decision", "cancel_requested", "interrupted"] as const;

export function refusal(code: experimental_PluginRpcRefusal["code"], message: string) {
  return new experimental_PluginRpcRefusal({ code, message });
}

export function publicError(error: unknown) {
  if (error instanceof experimental_PluginRpcRefusal) return error;
  if (error instanceof SftpRefusal) return refusal(SFTP_REFUSALS[error.code], error.code);
  if (!isCommanderError(error)) return refusal("invalid", "Commander operation failed");
  const code = error.code === "permission_denied" || error.code === "read_only" || error.code === "consent_required"
    || error.code === "host_key_rejected" ? "forbidden"
    : error.code === "not_found" ? "not_found"
    : error.code === "changed_since_plan" || error.code === "already_exists" ? "conflict" : "invalid";
  return refusal(code, JSON.stringify(error.toShape()));
}

function damaged(job: OperationJob): DamagedJob | null {
  return job.state === "unknown" && job.error?.code === "internal" && job.error.message === "Stored job is damaged"
    ? { id: job.id, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: job.createdAt }
    : null;
}

function ownedBy(initiator: Initiator, jobInitiator: Initiator) {
  return initiator.kind === "owner" ? jobInitiator.kind === "owner"
    : jobInitiator.kind === "agent" && initiator.threadId === jobInitiator.threadId;
}

function refs(plan: OperationPlan): string[] {
  return [plan.sourceEndpoint, plan.targetEndpoint].filter((id) => id !== null);
}

function autoRunAllowed(plan: OperationPlan, initiator: Initiator, grants: AgentGrant[]) {
  if (!authorize(initiator, plan, grants).ok || REQUIRED[plan.kind].includes("delete")) return false;
  const mayOverwrite = plan.conflictPolicy === "overwrite" || plan.conflictPolicy === "overwriteIfNewer";
  // The runner can stage a sibling of a destination or choose a free sibling on conflict.
  // A grant for the destination leaf alone cannot authorize that.
  return plan.items.every(({ target }) => {
    if (!target) return true;
    if (mayOverwrite && !covers(grants, target, "delete")) return false;
    const directory = parent(target.path);
    return directory !== null && covers(grants, { endpoint: target.endpoint, path: directory }, "write");
  });
}

function effectiveGrants(rows: AgentGrant[], endpoint: string): AgentGrant[] {
  // SFTP lstat protects the final component only. An intermediate link may leave
  // a lexical subdirectory, so only a grant covering the whole remote root applies.
  return endpoint.startsWith("sftp:") ? rows.filter((row) => row.scope.segments.length === 0) : rows;
}

/**
 * Reconciling an unknown item may remove a temporary file beside its target, so the agent
 * needs write on that directory, as an automatic run does. Without it nothing is reconciled.
 */
function unknownTargetsWritable(rows: AgentGrant[], job: OperationJob) {
  return job.items.every(({ outcome }, index) => {
    const target = job.plan.items[index].target;
    if (outcome !== "unknown" || !target) return true;
    const directory = parent(target.path);
    return directory !== null && covers(rows, { endpoint: target.endpoint, path: directory }, "write");
  });
}

function operationGrants(rows: AgentGrant[], plan: OperationPlan): AgentGrant[] {
  return [...new Set(refs(plan))].flatMap((endpoint) => effectiveGrants(rows, endpoint)
    .filter((row) => row.endpoint === "*" || row.endpoint === endpoint)
    .map((row) => ({ ...row, endpoint })));
}

function canObserve(rows: AgentGrant[], ref: ResourceRef) {
  const grants = effectiveGrants(rows, ref.endpoint);
  return covers(grants, ref, "observe") || covers(grants, ref, "read");
}

export function createOperations(deps: {
  endpoints: Endpoints;
  runner: JobRunner;
  store: AgentJobStore;
  planner: PlannerDeps;
  grants: ReturnType<typeof createAgentGrants>;
  kv: PluginKvStorage;
  publish(kind: "job" | "dir" | "endpoints", id: string): void;
  ready(): Promise<void>;
  isManaged(id: string): boolean;
  scans: ScanRunner;
}) {
  const { endpoints, runner, store, planner, grants, kv, publish } = deps;
  const plans = new Map<string, { plan: OperationPlan; bytes: number; created: number }>();
  const scanEstimates = new Map<string, {
    initiator: Initiator; request: string; snapshot: string; expires: number;
  }>();
  let accessQueue: Promise<unknown> = Promise.resolve();

  function serializeAccess<T>(action: () => Promise<T>): Promise<T> {
    const result = accessQueue.then(action);
    accessQueue = result.catch(() => {});
    return result;
  }

  function remember(plan: OperationPlan) {
    const bytes = Buffer.byteLength(JSON.stringify(plan));
    const initiator = plan.initiator;
    const agent = initiator.kind === "agent";
    const actorLimit = agent ? maxThreadPlans : maxPlans;
    const actorBytesLimit = agent ? maxAgentPlanBytes : maxPlanBytes;
    if (bytes > actorBytesLimit) throw refusal("invalid", "Operation plan exceeds the storage limit");
    const now = Date.now();
    const own: [string, number][] = [];
    let otherCount = 0;
    let otherBytes = 0;
    for (const [id, entry] of plans) {
      if (now - entry.created > lifetime) plans.delete(id);
      else if (ownedBy(initiator, entry.plan.initiator)) own.push([id, entry.bytes]);
      else if (agent && entry.plan.initiator.kind === "agent") {
        otherCount++;
        otherBytes += entry.bytes;
      }
    }
    if (otherCount >= maxPlans || otherBytes + bytes > maxPlanBytes) {
      throw refusal("conflict", "Agent plan pool is full");
    }
    let ownBytes = own.reduce((total, [, size]) => total + size, 0);
    for (let index = 0; index < own.length; index++) {
      const count = own.length - index;
      if (count < actorLimit && ownBytes + bytes <= actorBytesLimit
        && otherCount + count < maxPlans && otherBytes + ownBytes + bytes <= maxPlanBytes) break;
      const [id, size] = own[index];
      plans.delete(id);
      ownBytes -= size;
    }
    plans.set(plan.id, { plan: structuredClone(plan), bytes, created: now });
  }

  async function requireJob(id: string, initiator?: Initiator) {
    const job = await store.get(id);
    if (!job) throw refusal("not_found", "Job not found");
    if (initiator && !ownedBy(initiator, job.plan.initiator)) throw refusal("forbidden", "Job belongs to another initiator");
    if (damaged(job)) throw refusal("invalid", "Stored job is damaged");
    return job;
  }

  async function pending(id: string, digest: string) {
    const job = await requireJob(id);
    if (job.plan.digest !== digest) throw refusal("conflict", "Plan digest does not match");
    if (!job.awaitsOwner || job.state !== "pending") throw refusal("conflict", "Job is no longer awaiting approval");
    return job;
  }

  async function checkMetadata(initiator: Initiator, ref: ResourceRef) {
    if (initiator.kind === "owner") return;
    if (!canObserve(await grants.forThread(initiator.threadId), ref)) {
      throw refusal("forbidden", "Path is outside the agent's grant");
    }
  }

  async function uncoveredJobs(jobs: OperationJob[]) {
    const grantsByThread = new Map<string, AgentGrant[]>();
    const uncovered: OperationJob[] = [];
    for (const job of jobs) {
      const { initiator } = job.plan;
      if (initiator.kind !== "agent" || job.awaitsOwner || store.hasOwnerApproval(job.id)) continue;
      let rows = grantsByThread.get(initiator.threadId);
      if (!rows) {
        rows = await grants.forThread(initiator.threadId);
        grantsByThread.set(initiator.threadId, rows);
      }
      if (!autoRunAllowed(job.plan, initiator, operationGrants(rows, job.plan))) uncovered.push(job);
    }
    return uncovered;
  }

  const cancellable: ReadonlySet<JobState> = new Set(activeStates);
  async function requestCancel(job: OperationJob) {
    let current: OperationJob | null = job;
    while (current && cancellable.has(current.state)) {
      if (current.state === "pending" || deps.isManaged(current.id)) {
        await runner.cancel(current.id);
        return;
      }
      if (current.state === "cancel_requested") {
        runner.signalRecoveryCancellation(current.id);
        return;
      }
      // A persisted job may have a checkpoint from a previous process.
      // Preserve it and let recovery reconcile in cancellation mode.
      if (await store.update(current.id, {
        state: "cancel_requested", pendingConflict: null, updatedAt: planner.now().toISOString(),
      }, current.state)) {
        runner.signalRecoveryCancellation(current.id);
        publish("job", current.id);
        return;
      }
      current = await store.get(current.id);
    }
  }

  async function changeGrants(threadId: string, update: () => Promise<void>) {
    const cancellations = await serializeAccess(async () => {
      await update();
      deps.scans.cancelAgent(threadId);
      const active = await store.list({ states: [...activeStates],
        threadId, limit: Number.MAX_SAFE_INTEGER });
      return uncoveredJobs(active);
    });
    const results = await Promise.allSettled(cancellations.map(requestCancel));
    if (results.some(({ status }) => status === "rejected")) {
      throw refusal("conflict", "Grant updated but job cancellation could not be confirmed");
    }
    return {};
  }

  async function jobPage({ states, limit, cursor }: RpcInput<"job_list">, threadId?: string) {
    if (states?.includes("unknown")) return store.listUnknownPage({ states, limit, cursor, threadId });
    return { jobs: await store.list({ states, limit, threadId }) };
  }

  // Scan preflight uses metadata only. Work uses the same snapshots so a fresh
  // listing or stat cannot silently raise a remote read budget after approval.
  async function prepareScan(input: RpcInput<"scan_start">, signal: AbortSignal) {
    const location = (ref: ResourceRef) => ({ provider: endpoints.provider(ref.endpoint), path: ref.path });
    if (input.kind === "checksum") {
      const { provider, path } = location(input.ref);
      const expected = await scanFile({ provider, path }, signal);
      return {
        planned: [estimateRead([expected])],
        snapshot: [expected],
        async work(ctx: ScanContext): Promise<ScanResult> {
          const sha256 = await checksum(provider, path, ctx.signal, { ...scanHash(ctx), expected });
          ctx.progress({ items: 1 });
          return { sha256 };
        },
      };
    }

    const left = location(input.left);
    const right = location(input.right);
    if (input.kind === "files") {
      const a = await scanFile(left, signal);
      const b = await scanFile(right, signal);
      return {
        planned: input.mode === "size" || a.size !== b.size ? [0n, 0n] : [estimateRead([a]), estimateRead([b])],
        snapshot: [a, b],
        async work(ctx: ScanContext): Promise<ScanResult> {
          const comparison = await compareFiles(left, right, input.mode, ctx.signal, { ...scanHash(ctx), expected: [a, b] });
          ctx.progress({ items: 1 });
          return { comparison };
        },
      };
    }

    const a = await scanDir(left, input.limit, signal);
    const b = await scanDir(right, input.limit, signal);
    return {
      planned: input.by === "sha256" ? [estimateRead(a.entries), estimateRead(b.entries)] : [0n, 0n],
      snapshot: [a, b],
      async work(ctx: ScanContext): Promise<ScanResult> {
        const equal: [Entry, Entry][] = [];
        const diff = await compareDirs(left, right, input, ctx.signal, {
          ...scanHash(ctx), listings: [a, b], onItem: () => ctx.progress({ items: 1 }),
          onEqual: (left, right) => equal.push([left, right]),
        });
        if (diff.partial) ctx.markPartial("Directory entry limit reached");
        return { ...diff, equal };
      },
    };
  }

  function requireScanEstimate(id: string, initiator: Initiator, request: string) {
    const estimate = scanEstimates.get(id);
    if (!estimate || Date.now() >= estimate.expires) {
      scanEstimates.delete(id);
      throw refusal("forbidden", "Scan estimate is missing or expired");
    }
    if (!ownedBy(initiator, estimate.initiator) || estimate.request !== request) {
      throw refusal("forbidden", "Scan estimate does not match the request");
    }
    return estimate;
  }

  async function checkScanRead(initiator: Initiator, paths: ResourceRef[]) {
    if (initiator.kind === "owner") return;
    const rows = await grants.forThread(initiator.threadId);
    if (paths.some((ref) => !covers(effectiveGrants(rows, ref.endpoint), ref, "read"))) {
      throw refusal("forbidden", "Path is outside the agent's grant");
    }
  }

  return {
    async endpointsList(initiator: Initiator, signal: AbortSignal) {
      const endpointsList = await endpoints.list(signal);
      if (initiator.kind === "owner") return { endpoints: endpointsList };
      const rows = await grants.forThread(initiator.threadId);
      return { endpoints: endpointsList.filter(({ id }) => rows.some((grant) => grant.endpoint === id || grant.endpoint === "*")) };
    },
    async home(id: string, signal: AbortSignal) {
      await endpoints.prepare([id], signal);
      return { path: endpoints.home(id) };
    },
    async list(input: RpcInput<"dir_list">, initiator: Initiator, signal: AbortSignal) {
      const { ref, cursor, limit } = input;
      await checkMetadata(initiator, ref);
      await endpoints.prepare([ref.endpoint], signal);
      return endpoints.provider(ref.endpoint).list(ref.path, { cursor, limit }, signal);
    },
    async stat(ref: ResourceRef, initiator: Initiator, signal: AbortSignal) {
      await checkMetadata(initiator, ref);
      await endpoints.prepare([ref.endpoint], signal);
      return endpoints.provider(ref.endpoint).stat(ref.path, signal);
    },
    async createPlan(input: RpcInput<"plan_create">, initiator: Initiator, signal: AbortSignal) {
      const limits = initiator.kind === "agent" ? { ...planner.limits, maxItems: maxAgentPlanItems } : planner.limits;
      const paths = [...input.sources];
      if (input.targetDir) paths.push(input.targetDir);
      if (input.kind === "rename" && input.sources[0]) {
        const { endpoint, path } = input.sources[0];
        const directory = parent(path);
        if (directory) paths.push({ endpoint, path: directory });
      }
      const rows = initiator.kind === "agent" ? await grants.forThread(initiator.threadId) : [];
      const restricted = initiator.kind === "agent" && paths.some((ref) => !canObserve(rows, ref));
      try {
        if (input.sources.length > limits.maxItems) throw refusal("invalid", "Selection exceeds the plan item limit");
        await endpoints.prepare(paths.map(({ endpoint }) => endpoint), signal);
        const plan = await buildPlan({ ...input, initiator }, { ...planner, limits }, signal);
        remember(plan);
        return plan;
      } catch (error) {
        if (restricted) throw refusal("forbidden", "Commander planning failed outside the metadata grant");
        throw error;
      }
    },
    async runPlan({ planId, digest }: RpcInput<"plan_run">, initiator: Initiator, signal: AbortSignal) {
      await deps.ready();
      const entry = plans.get(planId);
      if (!entry || Date.now() - entry.created > lifetime) {
        plans.delete(planId);
        throw refusal("not_found", "Plan is unavailable");
      }
      const { plan } = entry;
      if (!ownedBy(initiator, plan.initiator)) throw refusal("forbidden", "Plan belongs to another initiator");
      if (plan.digest !== digest) throw refusal("conflict", "Plan digest does not match");
      await endpoints.prepare(refs(plan), signal);
      return serializeAccess(async () => {
        const rows = initiator.kind === "agent" ? await grants.forThread(initiator.threadId) : [];
        const awaitsOwner = initiator.kind === "agent" && !autoRunAllowed(plan, initiator, operationGrants(rows, plan));
        if (initiator.kind === "agent" && awaitsOwner) {
          const size = store.approvalQueueSize(initiator.threadId);
          if (size.thread >= maxThreadApprovals || size.total >= maxApprovals) {
            throw new CommanderError("limit_exceeded", "Commander approval queue is full");
          }
        }
        signal.throwIfAborted();
        if (plans.get(planId) !== entry) throw refusal("conflict", "Plan is no longer available");
        plans.delete(planId);
        return runner.submit(plan, { awaitsOwner });
      });
    },
    async jobs(input: RpcInput<"job_list">) {
      const page = await jobPage(input);
      return { ...page, jobs: page.jobs.map(jobView) };
    },
    async job(id: string) {
      const job = await store.get(id);
      return job === null ? null : jobView(job);
    },
    async agentJobs(input: RpcInput<"job_list">, threadId: string) {
      const page = await jobPage(input, threadId);
      const rows = await grants.forThread(threadId);
      return { ...page, jobs: page.jobs.map((job) => agentJobView(job, rows)) };
    },
    async cancel(id: string, initiator: Initiator) {
      const job = await requireJob(id, initiator.kind === "agent" ? initiator : undefined);
      await requestCancel(job);
      return {};
    },
    // S17: план повтора принадлежит запрашивающему, поэтому plan_run проверит его гранты.
    async retry(id: string, initiator: Initiator, signal: AbortSignal) {
      await deps.ready();
      const job = await requireJob(id, initiator.kind === "agent" ? initiator : undefined);
      if (initiator.kind === "agent") {
        // Grants are checked on the job's own items before reconciliation may write anything.
        const rows = await grants.forThread(initiator.threadId);
        if (!authorize(initiator, job.plan, operationGrants(rows, job.plan)).ok || !unknownTargetsWritable(rows, job)) {
          throw refusal("forbidden", "Commander planning failed outside the metadata grant");
        }
      }
      signal.throwIfAborted();
      const retry = await runner.retryJob(id, initiator, signal);
      signal.throwIfAborted();
      if (retry.plan) remember(retry.plan);
      return { plan: retry.plan, excluded: retry.excluded };
    },
    async decide({ jobId, ...decision }: RpcInput<"job_decide">, signal: AbortSignal) {
      await deps.ready();
      const job = await requireJob(jobId);
      if (decision.action !== "cancel") await endpoints.prepare(refs(job.plan), signal);
      await runner.decide(jobId, decision);
      return {};
    },
    async checkPlan({ jobId, digest }: RpcInput<"plan_check">, signal: AbortSignal) {
      await deps.ready();
      const { plan } = await pending(jobId, digest);
      await endpoints.prepare(refs(plan), signal);
      const result = await revalidate(plan, planner, signal);
      signal.throwIfAborted();
      await pending(jobId, digest);
      const checkedAt = planner.now().toISOString();
      return result.ok ? { ok: true as const, checkedAt } : { ok: false as const, changed: result.changed, checkedAt };
    },
    async approve({ jobId, digest }: RpcInput<"plan_approve">, signal: AbortSignal) {
      await deps.ready();
      const job = await pending(jobId, digest);
      await endpoints.prepare(refs(job.plan), signal);
      signal.throwIfAborted();
      await runner.approve(jobId);
      return requireJob(jobId);
    },
    async reject({ jobId, digest }: RpcInput<"plan_reject">) {
      await deps.ready();
      await pending(jobId, digest);
      // A single CAS persists the rejection and its reason before publishing.
      if (!await store.update(jobId, {
        state: "cancelled", error: new CommanderError("cancelled", "rejected_by_owner").toShape(),
        updatedAt: planner.now().toISOString(),
      }, "pending")) throw refusal("conflict", "Job is no longer awaiting approval");
      publish("job", jobId);
      return requireJob(jobId);
    },
    async requestAccess(input: RpcInput<"sftp_request_access">, signal: AbortSignal) {
      const result = await endpoints.remote.call("hub_sftp_request_access", input, signal);
      publish("endpoints", "sftp:" + input.profileId);
      return result;
    },
    async getState(threadId?: string) {
      return { state: UiState.safeParse(await kv.get(stateKey(threadId))).data ?? null };
    },
    async setState(state: UiState, threadId?: string) {
      if (Buffer.byteLength(JSON.stringify(state)) > 256 * 1024) throw refusal("invalid", "UI state exceeds 256 KB");
      await kv.set(stateKey(threadId), state);
      return {};
    },
    async prepareRecovery(signal: AbortSignal) {
      const recovery = await store.list({ states: [...activeStates], limit: Number.MAX_SAFE_INTEGER });
      const ids = new Set(recovery.filter((job) => !job.awaitsOwner).flatMap((job) => refs(job.plan)));
      await Promise.allSettled([...ids].map((id) => endpoints.prepare([id], signal)));
      signal.throwIfAborted();
      const uncovered = await uncoveredJobs(recovery);
      for (const job of uncovered) {
        signal.throwIfAborted();
        await requestCancel(job);
      }
    },
    async scanStart(input: RpcInput<"scan_start">, initiator: Initiator, signal: AbortSignal) {
      const paths = input.kind === "checksum" ? [input.ref] : [input.left, input.right];
      const ids = [...new Set(paths.map(({ endpoint }) => endpoint))];
      await checkScanRead(initiator, paths);
      await deps.ready();
      const remote = ids.some((id) => id.startsWith("sftp:"));
      const { estimateId, estimateOnly, ...scan } = input;
      const request = JSON.stringify(scan);
      if (!estimateOnly && remote && !estimateId) {
        throw refusal("forbidden", "A remote scan requires a confirmed estimate");
      }
      if (!estimateOnly && estimateId) requireScanEstimate(estimateId, initiator, request);
      await endpoints.prepare(ids, signal);
      const { planned, snapshot, work } = await prepareScan(input, signal);
      const bytes = planned.reduce((total, count) => total + count, 0n);
      const snapshotDigest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      return serializeAccess(async () => {
        await checkScanRead(initiator, paths);
        await deps.ready();
        signal.throwIfAborted();
        if (estimateOnly) {
          const now = Date.now();
          for (const [id, estimate] of scanEstimates) {
            if (now >= estimate.expires) scanEstimates.delete(id);
          }
          // Keep estimate issuance bounded and prevent agents from evicting owner estimates.
          const ownPool = [...scanEstimates].filter(([, item]) => item.initiator.kind === initiator.kind);
          const poolLimit = initiator.kind === "owner" ? 32 : 64;
          if (ownPool.length >= poolLimit) throw refusal("conflict", "Scan estimate pool is full");
          if (initiator.kind === "agent" && ownPool.filter(([, item]) => ownedBy(initiator, item.initiator)).length >= 16) {
            throw refusal("conflict", "Thread scan estimate pool is full");
          }
          const id = planner.uuid();
          scanEstimates.set(id, { initiator, request, snapshot: snapshotDigest, expires: now + 600_000 });
          const byEndpoint = new Map<string, bigint>();
          paths.forEach(({ endpoint }, index) => {
            byEndpoint.set(endpoint, (byEndpoint.get(endpoint) ?? 0n) + planned[index]);
          });
          return { estimateId: id, bytesPlanned: bytes.toString(),
            bytesByEndpoint: [...byEndpoint].map(([endpoint, count]) => ({ endpoint, bytesPlanned: count.toString() })) };
        }
        if (estimateId) {
          const estimate = requireScanEstimate(estimateId, initiator, request);
          scanEstimates.delete(estimateId);
          if (estimate.snapshot !== snapshotDigest) throw refusal("conflict", "Scan metadata changed; estimate again");
        }
        const job = deps.scans.start({
          kind: input.kind === "checksum" ? "checksum" : "compare", initiator, endpoints: ids, bytesPlanned: bytes,
        }, work);
        return scanJobView(job);
      });
    },
    scanGet(id: string) {
      const job = deps.scans.get(id);
      if (!job) return null;
      const result = deps.scans.result<ScanResult>(id);
      return { job: scanJobView(job), result,
        ...(job.state === "done" && result === null ? { reason: "result_expired" as const } : {}) };
    },
    scanCancel(id: string) {
      deps.scans.cancel(id);
      return {};
    },
    async scanTool(input: RpcInput<"scan_start">, initiator: Initiator, signal: AbortSignal) {
      const started = await this.scanStart(input, initiator, signal);
      if (!("id" in started)) return started;
      const cancel = () => deps.scans.cancel(started.id);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        await deps.scans.wait(started.id);
        signal.throwIfAborted();
        const job = deps.scans.get(started.id);
        if (job?.error) throw job.error;
        if (job?.state !== "done") throw refusal("conflict", "Commander scan did not complete");
        const result = deps.scans.result<ScanResult>(started.id);
        if (result && "onlyLeft" in result) {
          const safe = (entry: (typeof result.onlyLeft)[number]) => ({ ...entry, linkTarget: null });
          const { equal: _equal, ...diff } = result;
          return { ...diff, onlyLeft: result.onlyLeft.map(safe), onlyRight: result.onlyRight.map(safe),
            differ: result.differ.map(([left, right]) => [safe(left), safe(right)]) };
        }
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    listGrants: grants.list,
    setGrant: (grant: AgentGrant) => changeGrants(grant.threadId, () => grants.set(grant)),
    revokeGrant: (key: GrantKey) => changeGrants(key.threadId, () => grants.revoke(key)),
  };
}

export type Operations = ReturnType<typeof createOperations>;

export function jobView(job: OperationJob) {
  return damaged(job) ?? job;
}

function agentJobView(job: OperationJob, grants: AgentGrant[]) {
  const summary = { id: job.id, state: job.state, awaitsOwner: job.awaitsOwner };
  const visible = job.plan.items.every(({ source, target }) => source
    ? canObserve(grants, source)
    : target !== null && canObserve(grants, target));
  return damaged(job) ?? (visible ? { ...summary, progress: job.progress, initiator: job.plan.initiator } : summary);
}

function scanHash(ctx: ScanContext) {
  return {
    onBytes: (bytes: bigint) => ctx.progress({ bytes }),
    createHash() {
      const hash = createHash("sha256");
      return { update: (bytes: Uint8Array) => { hash.update(bytes); }, finish: () => hash.digest("hex") };
    },
  };
}

export function createRpcHandlers(ops: Operations): ExperimentalPluginRpcHandlersWithContext<typeof rpcSchemas> {
  const handlers: ExperimentalPluginRpcHandlersWithContext<typeof rpcSchemas> = {
    endpoints_list: (_, ctx) => ops.endpointsList(owner, ctx.experimental_signal),
    endpoint_home: ({ endpoint }, ctx) => ops.home(endpoint, ctx.experimental_signal),
    dir_list: (input, ctx) => ops.list(input, owner, ctx.experimental_signal),
    entry_stat: ({ ref }, ctx) => ops.stat(ref, owner, ctx.experimental_signal),
    plan_create: (input, ctx) => ops.createPlan(input, owner, ctx.experimental_signal),
    plan_run: (input, ctx) => ops.runPlan(input, owner, ctx.experimental_signal),
    job_list: (input) => ops.jobs(input),
    job_get: ({ jobId }) => ops.job(jobId),
    job_decide: (input, ctx) => ops.decide(input, ctx.experimental_signal),
    job_cancel: ({ jobId }) => ops.cancel(jobId, owner),
    // S17: повтор невыполненного из очереди.
    job_retry: ({ jobId }, ctx) => ops.retry(jobId, owner, ctx.experimental_signal),
    plan_check: (input, ctx) => ops.checkPlan(input, ctx.experimental_signal),
    plan_approve: (input, ctx) => ops.approve(input, ctx.experimental_signal),
    plan_reject: (input) => ops.reject(input),
    agent_grants_list: async () => ({ grants: await ops.listGrants() }),
    agent_grants_set: ({ grant }) => ops.setGrant(grant),
    agent_grants_revoke: (input) => ops.revokeGrant(input),
    sftp_request_access: (input, ctx) => ops.requestAccess(input, ctx.experimental_signal),
    ui_state_get: ({ threadId }) => ops.getState(threadId),
    ui_state_set: ({ state, threadId }) => ops.setState(state, threadId),
    scan_start: (input, ctx) => ops.scanStart(input, owner, ctx.experimental_signal),
    scan_get: ({ scanId }) => ops.scanGet(scanId),
    scan_cancel: ({ scanId }) => ops.scanCancel(scanId),
  };
  const wrap = <M extends keyof typeof handlers>(method: M) => {
    const handle = handlers[method] as (value: RpcInput<M>, ctx: Parameters<typeof handlers[M]>[1]) => unknown;
    return async (input: unknown, ctx: Parameters<typeof handlers[M]>[1]) => {
      if (ctx?.experimental_caller?.kind !== "client") throw refusal("forbidden", "Commander RPC requires an owner client");
      try {
        const parsed = rpcSchemas[method].input.safeParse(input);
        if (!parsed.success) throw refusal("invalid", "Invalid Commander request");
        ctx.experimental_signal.throwIfAborted();
        return await handle(parsed.data as RpcInput<M>, ctx);
      } catch (error) {
        throw publicError(error);
      }
    };
  };
  return Object.fromEntries(Object.keys(handlers).map((method) => [method, wrap(method as keyof typeof handlers)])) as typeof handlers;
}
