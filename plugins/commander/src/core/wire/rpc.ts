import { z } from "zod";
import {
  ConflictDecision, ConflictPolicy, Endpoint, EndpointId, Entry, Initiator, JobProgress, JobState,
  OperationJob, OperationKind, OperationPlan, Permission, ResourceRef, Verify, Fingerprint,
} from "../model.ts";
import { CommanderErrorShape } from "../errors.ts";
import { NameSegment, ResourcePath } from "../path.ts";
import { LIST_PAGE_MAX } from "../provider.ts";
import { IMAGE_MIMES, MAX_RESPONSE_BYTES, MAX_VIEW_BYTES, VIEW_KINDS } from "../preview.ts";
import { Size } from "../size.ts";
import { sftpMethods } from "./remote-hub-sftp.ts";

const empty = z.strictObject({});
const jobId = z.strictObject({ jobId: z.uuid() });
// S17: файлы внутри каталога, чьё создание не подтверждено, в план не входят и считаются здесь.
export const RetryResult = z.strictObject({
  plan: OperationPlan.nullable(),
  excluded: z.array(z.strictObject({ count: z.int().min(1), reason: z.literal("parent_unconfirmed") })),
});
export type RetryResult = z.infer<typeof RetryResult>;
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
  createdAt: z.iso.datetime(),
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
const scanBytes = z.string().regex(/^(0|[1-9]\d{0,25})$/);
const scanId = z.strictObject({ scanId: z.uuid() });
const scanControl = {
  estimateOnly: z.boolean().optional(),
  estimateId: z.uuid().optional(),
};
const ChecksumRequest = z.strictObject({ kind: z.literal("checksum"), ref: ResourceRef });
const DirectoryScanRequest = z.strictObject({
  kind: z.literal("dirs"), left: ResourceRef, right: ResourceRef,
  by: z.enum(["size+mtime", "sha256"]), mtimeToleranceMs: z.int().min(0).max(86_400_000).default(2000),
  limit: z.int().min(1).max(LIST_PAGE_MAX).default(100),
});
export const ChecksumScan = ChecksumRequest.extend(scanControl);
export const CompareScan = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("files"), left: ResourceRef, right: ResourceRef,
    mode: z.enum(["size", "sha256", "bytes"]), ...scanControl,
  }),
  DirectoryScanRequest.extend(scanControl),
]);
const savedChecksum = scanId.extend({ request: ChecksumRequest });
const savedComparison = scanId.extend({ request: DirectoryScanRequest });
export type SavedUiScan = { scanId: string; request: z.output<typeof ChecksumRequest> | z.output<typeof DirectoryScanRequest> };
export const UiState = z.strictObject({
  left: pane,
  right: pane,
  activePane: z.enum(["left", "right"]),
  layout: z.enum(["horizontal", "vertical"]),
  split: z.number().min(0.1).max(0.9),
  lastChecksum: savedChecksum.optional(),
  lastComparison: savedComparison.optional(),
  inspectorCollapsed: z.boolean().optional(),
});
export type UiState = z.infer<typeof UiState>;

const uiScope = z.strictObject({ threadId: threadId.optional() });

export const ScanJobView = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["checksum", "compare", "search"]),
  initiator: Initiator,
  endpoints: z.array(EndpointId),
  state: z.enum(["running", "done", "failed", "cancelled", "interrupted"]),
  progress: z.strictObject({ items: z.int().nonnegative(), bytes: scanBytes, bytesPlanned: scanBytes.nullable() }),
  partial: z.boolean(),
  error: CommanderErrorShape.nullable(),
});
const scanResult = z.union([
  z.strictObject({ sha256: digest }),
  z.strictObject({ comparison: z.enum(["same", "different"]) }),
  z.strictObject({
    onlyLeft: z.array(Entry).max(LIST_PAGE_MAX), onlyRight: z.array(Entry).max(LIST_PAGE_MAX),
    differ: z.array(z.tuple([Entry, Entry])).max(LIST_PAGE_MAX),
    equal: z.array(z.tuple([Entry, Entry])).max(LIST_PAGE_MAX).optional(), same: z.int().nonnegative(), partial: z.boolean(),
  }),
]);
export type ScanResult = z.infer<typeof scanResult>;

export const ScanEstimateView = z.strictObject({
  estimateId: z.uuid(), bytesPlanned: scanBytes,
  bytesByEndpoint: z.array(z.strictObject({ endpoint: EndpointId, bytesPlanned: scanBytes })).min(1).max(2),
});
export type ScanEstimateView = z.infer<typeof ScanEstimateView>;
export const ScanGetView = z.strictObject({
  job: ScanJobView, result: scanResult.nullable(), reason: z.literal("result_expired").optional(),
});
export type ScanGetView = z.infer<typeof ScanGetView>;
const FileVersion = Fingerprint.pick({ size: true, mtimeNs: true });

export const rpcSchemas = {
  endpoints_list: { input: empty, output: z.strictObject({ endpoints: z.array(EndpointView) }) },
  endpoint_home: { input: z.strictObject({ endpoint: EndpointId }), output: z.strictObject({ path: ResourcePath }) },
  dir_list: {
    input: z.strictObject({ ref: ResourceRef, cursor: z.string().max(2048).nullable().default(null), limit: z.int().min(1).max(LIST_PAGE_MAX).default(100) }),
    output: z.strictObject({ entries: z.array(Entry).max(LIST_PAGE_MAX), cursor: z.string().max(2048).nullable() }),
  },
  entry_stat: { input: z.strictObject({ ref: ResourceRef }), output: Entry.nullable() },
  // Window of a file for F3 and the agent read tool. A reply is at most 1 MiB as JSON (the agent's
  // tool result is measured with its text escaped). `modes` lists what the file offers; `mode` picks
  // one. `expect` is the version of an earlier window, so chunks of one view share a version.
  file_read: {
    input: z.strictObject({
      ref: ResourceRef,
      offset: Size.default("0"),
      length: z.int().min(1).max(MAX_VIEW_BYTES).default(MAX_VIEW_BYTES),
      mode: z.enum(["auto", ...VIEW_KINDS]).default("auto"),
      expect: FileVersion.optional(),
    }),
    output: z.strictObject({
      version: FileVersion,
      modes: z.array(z.enum(VIEW_KINDS)).min(1).max(3),
      view: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("text"), text: z.string().max(MAX_RESPONSE_BYTES), truncated: z.boolean() }),
        z.strictObject({
          kind: z.literal("image"),
          mime: z.enum(IMAGE_MIMES),
          base64: z.string().max(MAX_RESPONSE_BYTES),
          truncated: z.boolean(),
        }),
        z.strictObject({
          kind: z.literal("binary"),
          lines: z.array(z.string().max(160)).max(MAX_RESPONSE_BYTES / 16),
          truncated: z.boolean(),
          shown: z.int().nonnegative().max(MAX_RESPONSE_BYTES),
          total: Size,
        }),
        z.strictObject({ kind: z.literal("chunk"), offset: Size, base64: z.string().max(MAX_RESPONSE_BYTES), truncated: z.boolean() }),
      ]),
    }),
  },
  plan_create: { input: PlanInput, output: OperationPlan },
  plan_run: { input: z.strictObject({ planId: z.uuid(), digest }), output: OperationJob },
  // Обычная выдача идёт по updated_at DESC (при равенстве по id ASC).
  // Фильтр с unknown сканирует по rowid DESC. nextCursor может прийти
  // с пустым jobs. Передайте его как cursor с тем же фильтром.
  job_list: {
    input: z.strictObject({
      states: z.array(JobState).max(9).optional(),
      limit: z.int().min(1).max(200).default(100),
      cursor: z.string().regex(/^-?(?:0|[1-9]\d{0,18})$/).optional(),
    }).refine(({ cursor, states }) => cursor === undefined || states?.includes("unknown") === true),
    output: z.strictObject({ jobs: z.array(JobView).max(200), nextCursor: z.string().optional() }),
  },
  job_get: { input: jobId, output: JobView.nullable() },
  job_decide: { input: ConflictDecision.extend(jobId.shape), output: empty },
  job_cancel: { input: jobId, output: empty },
  // S17: план повтора failed и неподтверждённых unknown-элементов; запускается через plan_run.
  job_retry: { input: jobId, output: RetryResult },
  // Read-only preflight for an owner client. Approval repeats validation against live metadata.
  plan_check: {
    input: jobId.extend({ digest }),
    output: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), checkedAt: z.iso.datetime() }),
      z.strictObject({
        ok: z.literal(false), checkedAt: z.iso.datetime(),
        changed: z.array(z.strictObject({
          index: z.int().nonnegative(),
          reason: z.enum(["source_changed", "target_changed"]),
        })).min(1).max(100_000),
      }),
    ]),
  },
  plan_approve: { input: jobId.extend({ digest }), output: OperationJob },
  plan_reject: { input: jobId.extend({ digest }), output: OperationJob },
  agent_grants_list: { input: empty, output: z.strictObject({ grants: z.array(AgentGrant).max(256) }) },
  agent_grants_set: { input: z.strictObject({ grant: AgentGrant }), output: empty },
  agent_grants_revoke: { input: GrantKey, output: empty },
  sftp_request_access: {
    input: sftpMethods.hub_sftp_request_access.input.omit({ reason: true }),
    output: sftpMethods.hub_sftp_request_access.output,
  },
  ui_state_get: { input: uiScope, output: z.strictObject({ state: UiState.nullable() }) },
  ui_state_set: { input: uiScope.extend({ state: UiState }), output: empty },
  // Estimate with metadata only, then pass the issued estimate ID after confirmation.
  scan_start: {
    input: z.union([ChecksumScan, CompareScan]),
    output: z.union([ScanEstimateView, ScanJobView]),
  },
  scan_get: { input: scanId, output: ScanGetView.nullable() },
  scan_cancel: { input: scanId, output: empty },
};

export type RpcInput<M extends keyof typeof rpcSchemas> = z.output<(typeof rpcSchemas)[M]["input"]>;
