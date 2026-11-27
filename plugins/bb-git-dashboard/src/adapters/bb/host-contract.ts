import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitAction, path } from "../../core/git.ts";
import { failure, gitResponse } from "../../core/workspace.ts";
import { verdict } from "../../core/catalog/project-scan.ts";

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
  sshHostname: {input:z.object({alias:z.string().max(253)}),output:z.discriminatedUnion("ok",[failure,z.object({ok:z.literal(true),hostname:z.string().max(253)})])},
});
