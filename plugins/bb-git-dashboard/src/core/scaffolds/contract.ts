import { z } from "zod";
import { answer } from "../answer.ts";
import { ciForge } from "../ci-templates/render.ts";
import { scaffold, scaffoldFile } from "./model.ts";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const value = z.union([z.string().max(200), z.boolean()]);
const source = z.enum(["builtin", "settings", "folder"]);
export const scaffoldsView = z.object({
  offered: z.array(z.object({key: z.string(), source, scaffold,
    /** The common layer of the templates repository the scaffold comes from. */
    common: z.object({files: z.array(scaffoldFile).max(100)}).optional()})),
  rejected: z.array(z.object({source, name: z.string(), issues: z.array(z.string())})),
  /** Values suggested for every scaffold: the current year. */
  suggested: z.record(z.string(), value),
  /** Accounts a new repository can be made with. */
  accounts: z.array(z.object({id, label: z.string(), kind: z.enum(["github", "gitea", "gitlab", "azure"]), username: z.string()})),
});
export type ScaffoldsView = z.infer<typeof scaffoldsView>;
export const scaffoldRequest = z.object({
  hostId: id, key: z.string().min(1).max(200), values: z.record(z.string(), value),
  /** A folder of the projects folder that holds projects ("" is the folder itself). */
  category: z.string().max(1024), ciForge: ciForge.nullable(),
  author: z.object({name: z.string().trim().min(1).max(200), email: z.string().trim().regex(/^[^\s@<>]+@[^\s@<>]+$/).max(200)}),
  /** A repository to make on a forge and push the first commit to; private unless public is chosen. */
  repository: z.object({accountId: id, owner: z.string().trim().min(1).max(255).nullable(), visibility: z.enum(["private", "public"])}).nullable(),
});
export type ScaffoldRequest = z.infer<typeof scaffoldRequest>;
export const scaffoldPreview = z.object({
  id, expires: z.string(), lines: z.array(z.string()),
  files: z.array(z.object({path: z.string(), bytes: z.number().int()})),
});
export const scaffoldsContract = {
  /** The scaffolds offered, built-in and own, with the own ones that failed their checks. */
  scaffoldsView: {input: z.object({hostId: id}), output: answer(scaffoldsView.shape)},
  /** Renders a scaffold on the server and shows where it goes and what it writes; scaffoldCreate confirms it. */
  scaffoldPrepare: {input: scaffoldRequest, output: answer({preview: scaffoldPreview})},
  /** Makes the prepared project: the folder, its files, git init and the first commit; the copy is attached in Git. */
  scaffoldCreate: {input: z.object({previewId: id}), output: answer({copyId: z.string(), root: z.string(),
    /** The new repository's path, when one was made, and whether main reached it. */
    repository: z.object({path: z.string(), pushed: z.boolean()}).nullable(),
    /** What is left to do by hand after a step that did not go through. */
    notes: z.array(z.string())})},
};
