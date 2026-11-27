import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext, type PluginKvStorage } from "@get-bb/plugin-sdk";
import { CommanderError, isCommanderError } from "../../core/errors.ts";
import type { JobRunner } from "../../core/job-runner.ts";
import type { JobStore } from "../../core/job-store.ts";
import type { Initiator, OperationJob, OperationPlan, ResourceRef } from "../../core/model.ts";
import { parent } from "../../core/path.ts";
import { authorize, REQUIRED } from "../../core/permissions.ts";
import { buildPlan, type PlannerDeps } from "../../core/planner.ts";
import { UiState, rpcSchemas, type AgentGrant, type DamagedJob, type GrantKey, type RpcInput } from "../../core/wire/rpc.ts";
import { SFTP_REFUSALS, SftpRefusal } from "../../core/wire/remote-hub-sftp.ts";
import { covers, type createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";

const owner = { kind: "owner" } as const;
const stateKey = "ui-state";
const maxPlanBytes = 16 * 1024 * 1024;
const maxPlans = 128;
const maxAgentPlanBytes = 4 * 1024 * 1024;
const maxThreadPlans = 32;
const maxAgentPlanItems = 10_000;
const lifetime = 30 * 60 * 1000;
const activeStates = ["pending", "running", "awaiting_decision", "cancel_requested", "interrupted"] as const;

export function refusal(code: experimental_PluginRpcRefusal["code"], message: string) {
  return new experimental_PluginRpcRefusal({ code, message });
}

export function publicError(error: unknown) {
  if (error instanceof experimental_PluginRpcRefusal) return error;
  if (error instanceof SftpRefusal) return refusal(SFTP_REFUSALS[error.code], error.code);
  if (!isCommanderError(error)) return refusal("invalid", "Commander operation failed");
  const code = error.code === "permission_denied" || error.code === "read_only" || error.code === "consent_required" ? "forbidden"
    : error.code === "not_found" ? "not_found"
    : error.code === "changed_since_plan" || error.code === "already_exists" ? "conflict" : "invalid";
  return refusal(code, JSON.stringify(error.toShape()));
}

function damaged(job: OperationJob): DamagedJob | null {
  return job.state === "unknown" && job.error?.code === "internal" && job.error.message === "Stored job is damaged"
    ? { id: job.id, state: "unknown", damaged: true, message: "Stored job is damaged" }
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
  store: JobStore;
  planner: PlannerDeps;
  grants: ReturnType<typeof createAgentGrants>;
  kv: PluginKvStorage;
  publish(kind: "job" | "dir" | "endpoints", id: string): void;
  ready(): Promise<void>;
  hasOwnerApproval(id: string): boolean;
}) {
  const { endpoints, runner, store, planner, grants, kv, publish } = deps;
  const plans = new Map<string, { plan: OperationPlan; bytes: number; created: number }>();
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
      if (initiator.kind !== "agent" || job.awaitsOwner || deps.hasOwnerApproval(job.id)) continue;
      let rows = grantsByThread.get(initiator.threadId);
      if (!rows) {
        rows = await grants.forThread(initiator.threadId);
        grantsByThread.set(initiator.threadId, rows);
      }
      if (!autoRunAllowed(job.plan, initiator, operationGrants(rows, job.plan))) uncovered.push(job);
    }
    return uncovered;
  }

  function changeGrants(threadId: string, update: () => Promise<void>) {
    return serializeAccess(async () => {
      await deps.ready();
      await update();
      const active = await store.list({ states: ["pending", "running", "awaiting_decision", "cancel_requested"],
        threadId, limit: Number.MAX_SAFE_INTEGER });
      const cancellations = await uncoveredJobs(active);
      const results = await Promise.allSettled(cancellations.map(({ id }) => runner.cancel(id)));
      if (results.some(({ status }) => status === "rejected")) {
        throw refusal("conflict", "Grant updated but job cancellation could not be confirmed");
      }
      return {};
    });
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
      if (input.sources.length > limits.maxItems) throw refusal("invalid", "Selection exceeds the plan item limit");
      const ids = input.sources.map(({ endpoint }) => endpoint);
      if (input.targetDir) ids.push(input.targetDir.endpoint);
      await endpoints.prepare(ids, signal);
      const plan = await buildPlan({ ...input, initiator }, { ...planner, limits }, signal);
      remember(plan);
      return plan;
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
        signal.throwIfAborted();
        if (plans.get(planId) !== entry) throw refusal("conflict", "Plan is no longer available");
        plans.delete(planId);
        return runner.submit(plan, { awaitsOwner });
      });
    },
    jobs: (input: RpcInput<"job_list">) => store.list(input),
    async agentJobs(input: RpcInput<"job_list">, threadId: string) {
      const jobs = await store.list({ ...input, threadId });
      const rows = await grants.forThread(threadId);
      return jobs.map((job) => agentJobView(job, rows));
    },
    async cancel(id: string, initiator: Initiator) {
      await deps.ready();
      await requireJob(id, initiator.kind === "agent" ? initiator : undefined);
      await runner.cancel(id);
      return {};
    },
    async decide({ jobId, ...decision }: RpcInput<"job_decide">, signal: AbortSignal) {
      await deps.ready();
      const job = await requireJob(jobId);
      if (decision.action !== "cancel") await endpoints.prepare(refs(job.plan), signal);
      await runner.decide(jobId, decision);
      return {};
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
    async getState() {
      return { state: UiState.safeParse(await kv.get(stateKey)).data ?? null };
    },
    async setState(state: UiState) {
      if (Buffer.byteLength(JSON.stringify(state)) > 256 * 1024) throw refusal("invalid", "UI state exceeds 256 KB");
      await kv.set(stateKey, state);
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
        if (job.state === "cancel_requested") continue;
        if (job.state === "pending") {
          await runner.cancel(job.id);
          continue;
        }
        // The previous process may have stopped after persisting the grant
        // change. Recover the last checkpoint in cancellation mode.
        if (await store.update(job.id, {
          state: "cancel_requested", pendingConflict: null, updatedAt: planner.now().toISOString(),
        }, job.state)) publish("job", job.id);
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

export function createRpcHandlers(ops: Operations): ExperimentalPluginRpcHandlersWithContext<typeof rpcSchemas> {
  const handlers: ExperimentalPluginRpcHandlersWithContext<typeof rpcSchemas> = {
    endpoints_list: (_, ctx) => ops.endpointsList(owner, ctx.experimental_signal),
    endpoint_home: ({ endpoint }, ctx) => ops.home(endpoint, ctx.experimental_signal),
    dir_list: (input, ctx) => ops.list(input, owner, ctx.experimental_signal),
    entry_stat: ({ ref }, ctx) => ops.stat(ref, owner, ctx.experimental_signal),
    plan_create: (input, ctx) => ops.createPlan(input, owner, ctx.experimental_signal),
    plan_run: (input, ctx) => ops.runPlan(input, owner, ctx.experimental_signal),
    job_list: async (input) => ({ jobs: (await ops.jobs(input)).map(jobView) }),
    job_decide: (input, ctx) => ops.decide(input, ctx.experimental_signal),
    job_cancel: ({ jobId }) => ops.cancel(jobId, owner),
    plan_approve: (input, ctx) => ops.approve(input, ctx.experimental_signal),
    plan_reject: (input) => ops.reject(input),
    agent_grants_list: async () => ({ grants: await ops.listGrants() }),
    agent_grants_set: ({ grant }) => ops.setGrant(grant),
    agent_grants_revoke: (input) => ops.revokeGrant(input),
    sftp_request_access: (input, ctx) => ops.requestAccess(input, ctx.experimental_signal),
    ui_state_get: () => ops.getState(),
    ui_state_set: ({ state }) => ops.setState(state),
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
