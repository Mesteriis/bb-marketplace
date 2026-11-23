import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { project } from "../../core/project-workspace.ts";
import { featureList, repositorySection } from "../../core/repository-features.ts";
import { connectionInput, connectionCheck } from "../../core/connection.ts";
import { path } from "../../core/git.ts";
import { copy, failure, gitResponse, id, operation, request } from "../../core/workspace.ts";

import { account, catalogPage, page, pull, pullDetails, repo } from "../../core/providers.ts";
import { preview, remoteOutcome, remoteRequest, remoteTarget } from "../../core/publication.ts";

const success = z.object({ok: z.literal(true)});
const copyResponse = z.discriminatedUnion("ok", [failure, success.extend({value: copy})]);
export const rpc = defineRpcContract({
  checkConnection: {input:connectionInput,output:z.discriminatedUnion("ok",[failure,success.extend({value:connectionCheck})])},
  saveConnection: {input:connectionInput,output:z.discriminatedUnion("ok",[failure,success.extend({value:account})])},
  accounts: {input:z.null(),output:z.discriminatedUnion("ok",[failure,success.extend({items:z.array(account)})])},
  repositories: {input:z.object({accountId:id,page,refresh:z.boolean()}),output:z.discriminatedUnion("ok",[failure,success.extend({value:catalogPage})])},
  pulls: {input:remoteTarget.extend({page}),output:z.discriminatedUnion("ok",[failure,success.extend({items:z.array(pull),more:z.boolean()})])},
  pull: {input:remoteTarget.extend({number:z.number().int().positive()}),output:z.discriminatedUnion("ok",[failure,success.extend({value:pullDetails})])},
  prepare: {input:remoteRequest,output:z.discriminatedUnion("ok",[failure,success.extend({value:preview})])},
  publish: {input:z.object({previewId:id}),output:z.discriminatedUnion("ok",[failure,success.extend({value:remoteOutcome})])},
  remoteActivity: {input:z.null(),output:z.array(remoteOutcome)},
  repositoryLink: {input:z.object({copyId:id}),output:z.discriminatedUnion("ok",[failure,success.extend({target:remoteTarget.nullable()})])},
  linkRepository: {input:z.object({copyId:id,target:remoteTarget.nullable()}),output:z.discriminatedUnion("ok",[failure,success])},
  repositoryFeatures: {input:z.object({copyId:id,section:repositorySection}),
    output:z.discriminatedUnion("ok",[failure,success.extend({repo,features:featureList})])},
  repositoryVisibility:{input:z.object({projectId:z.string().max(128),copyId:id,hidden:z.boolean()}),output:z.discriminatedUnion("ok",[failure,success])},
  projectVisibility: {input:z.object({projectId:id,hidden:z.boolean()}),output:z.discriminatedUnion("ok",[failure,success])},
  removeSource: {input:z.object({projectId:id,sourceId:id,hostId:id,path,mode:z.enum(["unlink","trash"])}),output:z.discriminatedUnion("ok",[failure,success])},
  catalog: {input: z.null(), output: z.object({
    hiddenRepositories:z.array(z.string()), copies:z.array(copy), hosts:z.array(z.object({id,name:z.string()})), projects:z.array(project),
    locations:z.array(z.object({hostId:id,projectId:id,path,name:z.string().nullable()})),
  })},
  attach: {input: z.object({hostId: id, root: path, projectId:id.optional()}), output: copyResponse},
  cloneLocal: {input: z.object({hostId: id, source: path, destination: path, projectId:id.optional()}), output: copyResponse},
  git: {input: request, output: gitResponse},
  context: {input: z.object({threadId: id}), output: z.discriminatedUnion("ok", [failure,
    success.extend({copy, environmentId: id, permission: z.enum(["none", "read", "write"])}),
  ])},
  permission: {input: z.object({threadId: id, copyId: id, permission: z.enum(["none", "read", "write"])}), output: z.discriminatedUnion("ok", [failure, success])},
  operations: {input: z.object({copyId: id}), output: z.array(operation)},
});
