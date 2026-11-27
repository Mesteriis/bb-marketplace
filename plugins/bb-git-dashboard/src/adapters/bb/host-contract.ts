import { defineRpcContract } from "@get-bb/plugin-sdk";
import { targetRequestSchema, targetSchema } from "../../core/code-review/model.ts";
import { reviewDiffSchema } from "../../core/code-review/diff.ts";
import { z } from "zod";
import { gitAction, path } from "../../core/git.ts";
import { failure, gitResponse } from "../../core/workspace.ts";
import { verdict } from "../../core/catalog/project-scan.ts";
import { commitDetails, historyPage, patchText } from "../../core/history/model.ts";

const identity = z.string().regex(/^[a-f0-9]{64}$/);
const rootResponse = z.discriminatedUnion("ok", [failure, z.object({ok: z.literal(true), root: path, identity, repository:identity.optional(), repositoryName:z.string().optional()})]);
const clone = z.url();
const username = z.string().min(1).max(128);
const exchangeAction = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("fetch")}),
  z.object({kind:z.literal("push"),expected:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),branch:z.string().max(250)}),
]);
export const hostContract = defineRpcContract({
  trash: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
  validate: {input: z.object({root: path}), output: rootResponse},
  git: {input: z.object({root: path, identity, action: gitAction}), output: gitResponse},
  cloneHttps: {input:z.object({clone, username, destination:path}),output:rootResponse},
  exchangeHttps: {input:z.object({clone, username, root:path, identity, action:exchangeAction}),output:gitResponse},
  cloneLocal: {input: z.object({source: path, destination: path}), output: rootResponse},
  originUrl: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),url:z.string().max(1000)})])},
  scanProjects: {input:z.object({root:path,exclude:z.array(z.string().max(255)).max(100)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),verdicts:z.array(verdict).max(20_000),truncated:z.boolean()})])},
  probeForge: {input:z.object({origin:z.url().max(300)}),output:z.object({kind:z.enum(["gitea","gitlab","unreachable"]).nullable()})},
  historyPage: {input:z.object({root:path,identity,offset:z.number().int().min(0),limit:z.number().int().min(1).max(200)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:historyPage})])},
  historyRevision: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),revision:z.string()})])},
  historyCommit: {input:z.object({root:path,identity,hash:z.string().max(64)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:commitDetails})])},
  historyPatch: {input:z.object({root:path,identity,hash:z.string().max(64).nullable(),path}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:patchText})])},
  /** `patches: false` lists files only (each patch deferred); `paths` limits the diff to those paths. */
  reviewDiff: {input:z.object({root:path,identity,target:targetRequestSchema,ignoreWhitespace:z.boolean(),patches:z.boolean().optional(),
    paths:z.array(z.string().min(1).max(4096)).max(200).optional()}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:reviewDiffSchema,target:targetSchema})])},
  reviewFile: {input:z.object({root:path,identity,path:z.string().min(1).max(4096)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),text:z.string(),sha256:z.string()})])},
  reviewWrite: {input:z.object({root:path,identity,path:z.string().min(1).max(4096),expected:z.string().regex(/^[0-9a-f]{64}$/),text:z.string().max(2*1024*1024)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),sha256:z.string()})])},
  sshHostname: {input:z.object({alias:z.string().max(253)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),hostname:z.string().max(253)})])},
  /** Starts or renews the 90-second watch of a working copy an open Review shows. */
  reviewWatch: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
});
/** What the host entry tells the server by itself: a watched copy changed. */
export const hostSignals = {reviewCopyChanged: {payload: z.object({root: path})}};
