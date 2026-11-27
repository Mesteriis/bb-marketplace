import { z } from "zod";
import { id } from "./workspace.ts";

export const providerKind = z.enum(["github", "azure", "gitea", "gitlab"]);
export const tokenSource = z.enum(["vault", "gh", "glab"]);
export const account = z.object({
  kind: providerKind, id, label:z.string().min(1).max(80), origin:z.url().max(300),
  organization:z.string().max(100).default(""), username:z.string().min(1).max(128).regex(/^[^\s\r\n:=]+$/),
  // Absent means "vault"; omitted so that accounts saved by 0.1.0 keep their JSON stamp.
  tokenSource:tokenSource.optional(),
});
export const sourceOf = (value: {tokenSource?: z.infer<typeof tokenSource>}) => value.tokenSource ?? "vault";
export type Account = z.infer<typeof account>;
export const repo = z.object({
  id:z.string().min(1).max(500), accountId:id, project:z.string(), name:z.string(),
  path:z.string(), clone:z.url(), branch:z.string().nullable(), canPush:z.boolean().nullable(),
});
export type Repo = z.infer<typeof repo>;
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const branch = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,249}$/);
export const pull = z.object({
  number:z.number().int().positive(), title:z.string(), body:z.string(), state:z.string(),
  head:z.object({repo:z.string(), branch:z.string(), sha:sha.nullable()}),
  base:z.object({repo:z.string(), branch:z.string(), sha:sha.nullable()}),
  updated:z.string().nullable(), merged:z.boolean(),
});
export type Pull = z.infer<typeof pull>;
export const pullDetails = z.object({
  pull, diff:z.string().nullable(), changes:z.array(z.string()),
  comments:z.array(z.object({author:z.string(), body:z.string()})),
  checks:z.array(z.object({name:z.string(), state:z.string()})),
  issues:z.array(z.string()),
});
export type PullDetails = z.infer<typeof pullDetails>;
export const pullMutation = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("create"), head:branch, base:branch, expected:sha, title:z.string().trim().min(1).max(220), body:z.string().max(8000)}),
  z.object({kind:z.literal("comment"), number:z.number().int().positive(), expected:sha, body:z.string().trim().min(1).max(8000)}),
  z.object({kind:z.literal("review"), number:z.number().int().positive(), expected:sha, reviewer:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/)}),
  z.object({kind:z.literal("merge"), number:z.number().int().positive(), expected:sha}),
  z.object({kind:z.literal("reopen"), number:z.number().int().positive(), expected:sha}),
]);
export type PullMutation = z.infer<typeof pullMutation>;
export const page = z.number().int().min(1).max(100);
export const catalogPage = z.object({items:z.array(repo), more:z.boolean(), observedAt:z.string()});
export type CatalogPage = z.infer<typeof catalogPage>;

export interface Provider {
  repositories(page: number): Promise<CatalogPage>;
  /** One repository by its provider path: `owner/name`, or `project/name` on Azure. */
  repository(path: string): Promise<Repo>;
  pulls(repo: Repo, page: number): Promise<{items: Pull[]; more: boolean}>;
  pull(repo: Repo, number: number): Promise<Pull>;
  details(repo: Repo, number: number): Promise<PullDetails>;
  branch(repo: Repo, branch: string): Promise<string>;
  mutate(repo: Repo, action: PullMutation): Promise<{number: number; outcome: "accepted" | "completed"}>;
  /** Creates one new file in a new branch started at the `base` commit of `baseBranch`; returns the new commit. */
  createFile(repo: Repo, change: NewFile): Promise<string>;
  /**
   * Creates an empty repository, of the account's user when `owner` is null, else of that organization or group (on
   * Azure: in that project, whose visibility the repository takes).
   */
  createRepository(spec: NewRepository): Promise<Repo>;
  /** Azure only: the visibility of the project a new repository would take. */
  repositoryVisibility?(owner: string): Promise<"private" | "public">;
}
export type NewRepository = {owner: string | null; name: string; description: string; visibility: "private" | "public"};
export type NewFile = {branch: string; base: string; baseBranch: string; path: string; content: string; message: string};
