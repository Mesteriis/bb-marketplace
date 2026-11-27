import { z } from "zod";
import type { Verdict } from "./project-scan.ts";

export type ProjectNode = {path: string; kind: "project" | "worktree" | "submodule"; children: ProjectNode[]};
export const projectNode: z.ZodType<ProjectNode> = z.object({
  path: z.string(), kind: z.enum(["project", "worktree", "submodule"]),
  get children() { return z.array(projectNode); },
});

const byPath = (left: ProjectNode, right: ProjectNode) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * Arranges found repositories as a tree: a worktree or submodule under the repository it belongs to, a repository
 * nested in another folder's checkout under the nearest enclosing one. Skipped folders are not part of the tree.
 */
export function projectTree(verdicts: Verdict[]): ProjectNode[] {
  const nodes = new Map<string, ProjectNode>();
  for (const verdict of verdicts) {
    if (verdict.kind !== "skipped") nodes.set(verdict.path, {path: verdict.path, kind: verdict.kind, children: []});
  }
  const enclosing = (path: string) => {
    for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
      const found = nodes.get(path.slice(0, end));
      if (found) return found;
    }
    return undefined;
  };
  const roots: ProjectNode[] = [];
  for (const verdict of verdicts) {
    const node = nodes.get(verdict.path);
    if (!node || verdict.kind === "skipped") continue;
    const owner = ("parent" in verdict ? nodes.get(verdict.parent) : undefined) ?? enclosing(verdict.path);
    (owner && owner !== node ? owner.children : roots).push(node);
  }
  const sort = (list: ProjectNode[]) => { list.sort(byPath); list.forEach(node => sort(node.children)); return list; };
  return sort(roots);
}
