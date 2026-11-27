import { z } from "zod";
import {
  ConflictDecision, ConflictPolicy, Endpoint, EndpointId, Entry, Initiator, JobProgress, JobState,
  OperationJob, OperationKind, OperationPlan, Permission, ResourceRef, Verify,
} from "../model.ts";
import { NameSegment, ResourcePath } from "../path.ts";
import { LIST_PAGE_MAX } from "../provider.ts";
import { sftpMethods } from "./remote-hub-sftp.ts";

const empty = z.strictObject({});
const jobId = z.strictObject({ jobId: z.uuid() });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const threadId = z.string().min(1).max(64);
export const GrantKey = z.strictObject({
  threadId,
  endpoint: EndpointId.or(z.literal("*")),
  scope: ResourcePath,
});
export type GrantKey = z.infer<typeof GrantKey>;
export const AgentGrant = GrantKey.extend({ permissions: z.array(Permission).min(1).max(6) });
export type AgentGrant = z.infer<typeof AgentGrant>;

export const EndpointView = Endpoint.extend({
  consent: z.enum(["none", "pending", "granted", "revoked"]).optional(),
});

export const PlanInput = z.strictObject({
  kind: OperationKind,
  sources: z.array(ResourceRef).max(100_000),
  targetDir: ResourceRef.nullable(),
  newName: NameSegment.nullable(),
  conflictPolicy: ConflictPolicy,
  verify: Verify,
});

export const DamagedJob = z.strictObject({
  id: z.uuid(), state: z.literal("unknown"), damaged: z.literal(true),
  message: z.literal("Stored job is damaged"),
});
export type DamagedJob = z.infer<typeof DamagedJob>;
export const JobView = z.union([OperationJob, DamagedJob]);
export const AgentJob = z.strictObject({
  id: z.uuid(), state: JobState, awaitsOwner: z.boolean(), progress: JobProgress, initiator: Initiator,
});

const tab = z.strictObject({
  endpoint: EndpointId,
  path: ResourcePath,
  sort: z.strictObject({ by: z.enum(["name", "kind", "size", "mtime"]), direction: z.enum(["asc", "desc"]) }),
  filter: z.string().max(1024),
  selection: z.array(NameSegment).max(10_000),
  scrollTop: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
});
const pane = z.strictObject({ tabs: z.array(tab).max(32), activeTab: z.int().min(0).max(31).nullable() })
  .refine(({ tabs, activeTab }) => tabs.length === 0 ? activeTab === null : activeTab !== null && activeTab < tabs.length);
export const UiState = z.strictObject({
  left: pane,
  right: pane,
  activePane: z.enum(["left", "right"]),
  layout: z.enum(["horizontal", "vertical"]),
  split: z.number().min(0.1).max(0.9),
});
export type UiState = z.infer<typeof UiState>;

export const rpcSchemas = {
  endpoints_list: { input: empty, output: z.strictObject({ endpoints: z.array(EndpointView) }) },
  endpoint_home: { input: z.strictObject({ endpoint: EndpointId }), output: z.strictObject({ path: ResourcePath }) },
  dir_list: {
    input: z.strictObject({ ref: ResourceRef, cursor: z.string().max(2048).nullable().default(null), limit: z.int().min(1).max(LIST_PAGE_MAX).default(100) }),
    output: z.strictObject({ entries: z.array(Entry).max(LIST_PAGE_MAX), cursor: z.string().max(2048).nullable() }),
  },
  entry_stat: { input: z.strictObject({ ref: ResourceRef }), output: Entry.nullable() },
  plan_create: { input: PlanInput, output: OperationPlan },
  plan_run: { input: z.strictObject({ planId: z.uuid(), digest }), output: OperationJob },
  job_list: {
    input: z.strictObject({
      states: z.array(JobState).max(9).optional(),
      limit: z.int().min(1).max(200).default(100),
      cursor: z.string().regex(/^-?(?:0|[1-9]\d{0,18})$/).optional(),
    }).refine(({ cursor, states }) => cursor === undefined || states?.includes("unknown") === true),
    output: z.strictObject({ jobs: z.array(JobView).max(200), nextCursor: z.string().optional() }),
  },
  job_decide: { input: ConflictDecision.extend(jobId.shape), output: empty },
  job_cancel: { input: jobId, output: empty },
  plan_approve: { input: jobId.extend({ digest }), output: OperationJob },
  plan_reject: { input: jobId.extend({ digest }), output: OperationJob },
  agent_grants_list: { input: empty, output: z.strictObject({ grants: z.array(AgentGrant).max(256) }) },
  agent_grants_set: { input: z.strictObject({ grant: AgentGrant }), output: empty },
  agent_grants_revoke: { input: GrantKey, output: empty },
  sftp_request_access: {
    input: sftpMethods.hub_sftp_request_access.input.omit({ reason: true }),
    output: sftpMethods.hub_sftp_request_access.output,
  },
  ui_state_get: { input: empty, output: z.strictObject({ state: UiState.nullable() }) },
  ui_state_set: { input: z.strictObject({ state: UiState }), output: empty },
};

export type RpcInput<M extends keyof typeof rpcSchemas> = z.output<(typeof rpcSchemas)[M]["input"]>;
