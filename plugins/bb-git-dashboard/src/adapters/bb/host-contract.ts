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
  /** The catalog's local half: the projects of the projects folder with their remote URLs. */
  catalogLocal: {input:z.object({root:path,exclude:z.array(z.string().max(255)).max(100)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),root:path,truncated:z.boolean(),
      projects:z.array(z.object({path,name:z.string(),remotes:z.array(z.string().max(1000))})).max(20_000)})])},
  /** Status, fetch or pull of one project inside the projects folder; HTTPS takes the matching account's username. */
  catalogGit: {input:z.object({projectsRoot:path,root:path,action:z.enum(["status","fetch","pull"]),https:z.object({username}).nullable()}),output:gitResponse},
  probeForge: {input:z.object({origin:z.url().max(300)}),output:z.object({kind:z.enum(["gitea","gitlab","unreachable"]).nullable()})},
  historyPage: {input:z.object({root:path,identity,offset:z.number().int().min(0),limit:z.number().int().min(1).max(200)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:historyPage})])},
  historyRevision: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),revision:z.string()})])},
  historyCommit: {input:z.object({root:path,identity,hash:z.string().max(64)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:commitDetails})])},
  historyPatch: {input:z.object({root:path,identity,hash:z.string().max(64).nullable(),path}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:patchText})])},
  /** `patches: false` lists files only (each patch deferred); `paths` limits the diff to those paths. */
  reviewDiff: {input:z.object({root:path,identity,target:targetRequestSchema,ignoreWhitespace:z.boolean(),patches:z.boolean().optional(),
    paths:z.array(z.string().min(1).max(4096)).max(200).optional(),
    /** Gitignore patterns to leave out, and whether to add the copy's own ignore files to them. */
    ignore:z.object({patterns:z.array(z.string().max(1000)).max(1000),readFiles:z.boolean()}).optional()}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),value:reviewDiffSchema,target:targetSchema})])},
  reviewFile: {input:z.object({root:path,identity,path:z.string().min(1).max(4096)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),text:z.string(),sha256:z.string()})])},
  reviewWrite: {input:z.object({root:path,identity,path:z.string().min(1).max(4096),expected:z.string().regex(/^[0-9a-f]{64}$/),text:z.string().max(2*1024*1024)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),sha256:z.string()})])},
  sshHostname: {input:z.object({alias:z.string().max(253)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),hostname:z.string().max(253)})])},
  /** HEAD's latest commits, for the commit view's list. */
  reviewCommits: {input:z.object({root:path,identity}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),commits:z.array(z.object({sha:z.string(),subject:z.string()}))})])},
  /** The copy's files whose path holds every word of `query` (Any file view). */
  /** What a copy's stack is told by at HEAD (CI templates). */
  ciStack: {input:z.object({root:path,identity,branch:z.string().max(250).nullable()}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),
    ref:z.string().max(260),head:z.string().nullable(),
    paths:z.array(z.string().max(4096)).max(5000),manifests:z.record(z.string(),z.string().max(64*1024))})])},
  /** The own CI templates folder's JSON files. */
  ciTemplateFolder: {input:z.object({folder:z.string().min(1).max(1000)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),
    files:z.array(z.object({name:z.string().max(255),text:z.string().max(64*1024)})).max(50),skipped:z.array(z.string().max(255)).max(1000)})])},
  /** Makes a new project from a scaffold's files inside the projects folder: git init and the first commit. */
  scaffoldCreate: {input:z.object({projectsRoot:z.string().min(1).max(4096),category:z.string().max(1024),name:z.string().min(1).max(100),
    files:z.array(z.object({path:z.string().min(1).max(200),text:z.string().max(2*1024*1024),executable:z.boolean()})).max(400),
    author:z.object({name:z.string().trim().min(1).max(200),email:z.string().trim().min(3).max(200)}),message:z.string().min(1).max(200)}),
    output:rootResponse},
  /** The first push of a project made from a scaffold to its new forge repository (HTTPS, the system credential helper). */
  scaffoldPublish: {input:z.object({root:path,identity,clone,username}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
  /** The account's token saved in the Keychain for the address of a repository the plugin has just made (stdin to Git only). */
  scaffoldCredential: {input:z.object({root:path,identity,clone,username,secret:z.string().min(1).max(4096)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
  reviewFiles: {input:z.object({root:path,identity,query:z.string().max(200)}),
    output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),paths:z.array(z.string()),more:z.boolean()})])},
  /** Reverts an uncommitted file, or hunks of it, while its change is still the one shown (`changeRevision`). */
  reviewRevert: {input:z.object({root:path,identity,path:z.string().min(1).max(4096),revision:z.string().regex(/^[0-9a-f]{16}$/),
    hunks:z.array(z.number().int().min(0).max(10_000)).max(10_000).nullable()}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
  /** Starts or renews the 90-second watch of a working copy an open Review shows. */
  reviewWatch: {input:z.object({root:path,identity}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true)})])},
});
/** What the host entry tells the server by itself: a watched copy changed. */
export const hostSignals = {reviewCopyChanged: {payload: z.object({root: path})}};
