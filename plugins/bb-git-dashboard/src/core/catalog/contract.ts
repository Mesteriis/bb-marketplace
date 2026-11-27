import { z } from "zod";
import { answer } from "../answer.ts";
import { gitResult } from "../git.ts";
import { pull, repo } from "../providers.ts";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const kind = z.enum(["github", "gitlab", "gitea", "azure"]);
const folder = z.string().min(1).max(4096);
export const catalogView = z.object({
  /** The projects folder on that machine, resolved. */
  root: folder, truncated: z.boolean(),
  local: z.array(z.object({path: folder, name: z.string(), key: z.string().nullable()})),
  remote: z.array(z.object({key: z.string(), repo, kind, accounts: z.array(z.string()), localPath: folder.nullable()})),
  sources: z.array(z.object({id: z.string(), label: z.string(), kind, ok: z.boolean(), error: z.string().nullable(), fetchedAt: z.string().nullable(), count: z.number().int()})),
  /** Folders of the projects folder that hold projects, where a clone may go ("" is the folder itself). */
  categories: z.array(z.string()),
});
export const catalogContract = {
  /** Local projects of a machine's projects folder and every account's repositories in one catalog. */
  catalogView: {input: z.object({hostId: id, refresh: z.boolean()}), output: answer(catalogView.shape)},
  /** Status, fetch or pull of chosen projects of that folder, one result each. */
  catalogBulk: {input: z.object({hostId: id, roots: z.array(folder).min(1).max(50), action: z.enum(["status", "fetch", "pull"])}),
    output: answer({results: z.array(z.object({root: folder, ok: z.boolean(), code: z.string().nullable(), value: gitResult.nullable()}))})},
  /** The open pull requests of chosen repositories, for a look across them. */
  catalogPulls: {input: z.object({repos: z.array(z.object({accountId: id, repoId: z.string().min(1).max(500)})).min(1).max(20)}),
    output: answer({results: z.array(z.object({accountId: z.string(), repoId: z.string(), ok: z.boolean(), code: z.string().nullable(), pulls: z.array(pull)}))})},
};
