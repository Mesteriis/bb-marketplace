import { z } from "zod";
import { projectTree } from "./project-tree.ts";

export type ScanRules = {exclude: string[]; maxDepth: number};
export const defaultExclude = "node_modules,vendor,references";
export type GitMarker = {path: string; git: "dir"} | {path: string; git: "file"; gitdir: string | null};
export type SkipReason = "hidden" | "excluded" | "broken-gitdir";
export type Verdict =
  | {path: string; kind: "project"}
  | {path: string; kind: "worktree" | "submodule"; parent: string}
  | {path: string; kind: "skipped"; reason: SkipReason};

export const verdict = z.discriminatedUnion("kind", [
  z.object({path: z.string(), kind: z.literal("project")}),
  z.object({path: z.string(), kind: z.enum(["worktree", "submodule"]), parent: z.string()}),
  z.object({path: z.string(), kind: z.literal("skipped"), reason: z.enum(["hidden", "excluded", "broken-gitdir"])}),
]);
/** `~` is expanded on the host that is scanned. */
export const defaultProjectsRoot = "~/projects";
export const maxDepth = 6;

export const scanPreview = z.object({
  root: z.string(), truncated: z.boolean(),
  /** Top-level projects; `nested` counts repositories shown under an enclosing project. */
  projects: z.number().int(), nested: z.number().int(), worktrees: z.number().int(), submodules: z.number().int(),
  skipped: z.array(z.object({reason: z.enum(["hidden", "excluded", "broken-gitdir"]), count: z.number().int(), examples: z.array(z.string())})),
});
export type ScanPreview = z.infer<typeof scanPreview>;

export function parseExclude(value: string) {
  return value.split(",").map(name => name.trim()).filter(name => name && !/[\\/]/.test(name) && !/^\.+$/.test(name));
}

/** Whether the walk enters a folder. Hidden folders are never projects of their own. */
export function descend(name: string, rules: ScanRules): "descend" | "hidden" | "excluded" {
  if (name.startsWith(".")) return "hidden";
  return rules.exclude.includes(name) ? "excluded" : "descend";
}

/** Classifies a folder holding `.git`. `gitdir` is the resolved target of a `.git` file, or null if unreadable or missing. */
export function classifyMarker(marker: GitMarker): Verdict {
  if (marker.git === "dir") return {path: marker.path, kind: "project"};
  const linked = marker.gitdir && /^(.+)\/\.git\/(worktrees|modules)\/.+$/.exec(marker.gitdir);
  if (!linked) return {path: marker.path, kind: "skipped", reason: "broken-gitdir"};
  return {path: marker.path, kind: linked[2] === "worktrees" ? "worktree" : "submodule", parent: linked[1]};
}

export function summarize(root: string, verdicts: Verdict[], truncated: boolean, examples = 5): ScanPreview {
  const count = (kind: Verdict["kind"]) => verdicts.filter(verdict => verdict.kind === kind).length;
  const topLevel = projectTree(verdicts).filter(node => node.kind === "project").length;
  const skipped = new Map<SkipReason, string[]>();
  for (const verdict of verdicts) {
    if (verdict.kind === "skipped") skipped.set(verdict.reason, [...skipped.get(verdict.reason) ?? [], verdict.path]);
  }
  return {
    root, truncated, projects: topLevel, nested: count("project") - topLevel, worktrees: count("worktree"), submodules: count("submodule"),
    skipped: [...skipped].map(([reason, paths]) => ({reason, count: paths.length, examples: paths.slice(0, examples)}))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
  };
}
