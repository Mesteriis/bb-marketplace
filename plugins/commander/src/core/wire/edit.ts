import { NameSegment, ResourcePath } from "../path.ts";
import { z } from "zod";
import { EditId, EditRevision, WriteBackRequest, WriteBackResult } from "../edit-session.ts";
import { EDIT_CHUNK, EDIT_LIMIT } from "../edit-source.ts";
import { EndpointId, Fingerprint, ResourceRef } from "../model.ts";

export const EDIT_OPENER = "commander-private-editor";
const empty = z.strictObject({});
const id = z.strictObject({ sessionId: EditId });
const offset = z.int().min(0).max(EDIT_LIMIT);
const chunkSize = z.int().min(1).max(EDIT_CHUNK);
const revision = z.strictObject({ revision: EditRevision });
const data = z.base64().max(Math.ceil(EDIT_CHUNK / 3) * 4).refine((value) => atob(value).length <= EDIT_CHUNK);
const chunk = z.strictObject({ bytes: data, eof: z.boolean() });
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const snapshot = z.strictObject({ snapshotId: EditId });
const upload = z.strictObject({ upload: EditRevision });
const readSource = z.union([revision, snapshot]);
const proof = Fingerprint.extend({ sha256: digest });
const route = z.strictObject({ path: z.string().min(1) });

export const editHostSchemas = {
  editSourceIdentity: {
    input: z.strictObject({ path: ResourcePath }),
    output: z.strictObject({
      dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/),
      parentDev: z.string().regex(/^[0-9]+$/), parentIno: z.string().regex(/^[0-9]+$/),
      name: NameSegment,
    }).nullable(),
  },
  editCreate: { input: id.extend({ size: offset }), output: route },
  editRoute: { input: id.extend({ revision: EditRevision, name: z.string().min(1).max(1024) }), output: route },
  editReadChunk: {
    input: id.extend({ source: readSource, offset, length: chunkSize }),
    output: chunk,
  },
  editWriteChunk: { input: id.extend({ baseRevision: EditRevision, offset, bytes: data }), output: empty },
  editCommitRevision: { input: id.extend({ baseRevision: EditRevision, sha256: digest, initial: z.boolean().optional() }), output: revision },
  editSnapshot: { input: id.extend({ revision: EditRevision, snapshotId: EditId }), output: proof },
  editInspectSnapshot: { input: id.extend({ snapshotId: EditId }), output: proof.nullable() },
  editDelete: { input: id.extend({ source: z.union([revision, snapshot, upload]) }), output: empty },
  editDiscardUpload: { input: id.extend({ baseRevision: EditRevision.optional() }), output: empty },
  editSweep: {
    input: z.strictObject({ held: z.array(id.extend({
      revision: EditRevision.optional(), upload: EditRevision.optional(), snapshots: z.array(EditId),
    })) }),
    output: empty,
  },
};

const opener = z.strictObject({ id: z.literal(EDIT_OPENER), hostId: z.string().min(1), path: z.string().min(1) });
export const editRpcSchemas = {
  edit_estimate: {
    input: z.strictObject({ ref: ResourceRef }),
    output: z.strictObject({ estimateId: EditId, endpoint: EndpointId, bytesPlanned: z.string().regex(/^[0-9]+$/) }),
  },
  edit_open: {
    input: z.strictObject({ ref: ResourceRef, estimateId: EditId.optional() }),
    output: id.extend({ base: Fingerprint, opener }),
  },
  edit_route: { input: id, output: opener },
  edit_get: {
    input: id,
    output: id.extend({ revision: EditRevision, ref: ResourceRef, base: Fingerprint, hostId: z.string() }),
  },
  edit_read: { input: id.extend({ revision: EditRevision, offset, length: chunkSize }), output: chunk },
  edit_save: {
    input: id.extend({ baseRevision: EditRevision, offset, bytes: data, final: z.boolean(), sha256: digest.optional() })
      .refine(({ final, sha256 }) => final === (sha256 !== undefined), "The final chunk requires SHA-256"),
    output: revision,
  },
  edit_writeback: { input: WriteBackRequest, output: WriteBackResult },
  edit_compare: {
    input: id.extend({ conflictId: EditId }),
    output: z.union([z.strictObject({ kind: z.literal("text"), text: z.string() }), WriteBackResult.options[1]]),
  },
  edit_dismiss: { input: id.extend({ conflictId: EditId }), output: empty },
  edit_close: { input: id, output: empty },
};
