import { z } from "zod";
import { path } from "./git.ts";
import { id } from "./workspace.ts";
import { account, branch, pullMutation, repo } from "./providers.ts";

export const remoteTarget = z.object({accountId:id, repoId:z.string().min(1).max(500)});
export const remoteAction = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("clone"),hostId:id,destination:path}),
  z.object({kind:z.literal("fetch"),copyId:id}),
  z.object({kind:z.literal("push"),copyId:id}),
  z.object({kind:z.literal("pull"),action:pullMutation}),
  /** A rendered CI template: the file in a new branch from the default branch's head, then a pull request of it. */
  z.object({kind:z.literal("ciFile"),copyId:id,template:z.string().min(1).max(200),path:z.string().min(1).max(200),
    content:z.string().min(1).max(64 * 1024),branch,title:z.string().trim().min(1).max(220),body:z.string().max(4000)}),
]);
export type RemoteAction = z.infer<typeof remoteAction>;
export const remoteRequest = remoteTarget.extend({action:remoteAction});
export const preview = z.object({
  id, account, repo, action:remoteAction, lines:z.array(z.string()), expires:z.string(),
});
export type Preview = z.infer<typeof preview>;
export const remoteOutcome = z.object({
  id, kind:z.enum(["clone","fetch","push","pull","ciFile"]),
  target:remoteTarget, at:z.string(), status:z.enum(["pending","completed","accepted","failed","unknown"]),
  actor:z.string(), summary:z.array(z.string()), code:z.string().optional(),
  pullNumber:z.number().optional(), copyId:id.optional(),
});
export type RemoteOutcome = z.infer<typeof remoteOutcome>;
