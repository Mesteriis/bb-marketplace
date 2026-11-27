import { z } from "zod";
import { answer } from "../answer.ts";
import { branch } from "../providers.ts";
import { preview } from "../publication.ts";
import { ciForge, ciTemplate } from "./render.ts";
import { stackIds } from "./stack.ts";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const value = z.union([z.string().max(100), z.boolean()]);
const source = z.enum(["builtin", "settings", "folder"]);
export const ciTemplatesView = z.object({
  forge: ciForge,
  repo: z.object({path: z.string(), name: z.string(), branch: z.string().nullable(), make: z.boolean()}),
  /** Where the stack was read: `origin/<default branch>` as last fetched, or HEAD when the copy has no such ref. */
  ref: z.string(),
  /** The commit the stack was read at, or null before the first commit. */
  head: z.string().nullable(),
  stacks: z.array(z.object({id: z.enum(stackIds), evidence: z.array(z.string()), defaults: z.record(z.string(), value)})),
  offered: z.array(z.object({key: z.string(), source, matches: z.boolean(), template: ciTemplate})),
  rejected: z.array(z.object({source, name: z.string(), issues: z.array(z.string())})),
  /** CI files already at that ref. */
  existing: z.array(z.string()),
});
export type CiTemplatesView = z.infer<typeof ciTemplatesView>;
export const ciTemplateRequest = z.object({
  copyId: id, key: z.string().min(1).max(200), values: z.record(z.string(), value),
  branch, title: z.string().trim().min(1).max(220), body: z.string().max(4000),
});
export const ciTemplatesContract = {
  /** The templates for a copy's forge, with the stack found at HEAD and the own templates that failed their checks. */
  ciTemplatesView: {input: z.object({copyId: id}), output: answer(ciTemplatesView.shape)},
  /** Renders a template on the server and prepares its file in a new branch and a pull request; publish confirms it. */
  ciTemplatePrepare: {input: ciTemplateRequest, output: answer({preview, file: z.object({path: z.string(), text: z.string()})})},
};
