// The Projects page's table: a row per attached copy with its pull request and newest run, and the views over them. No I/O.
import type { Run } from "../ci/model.ts";
import { isUnpushed, runAt, type CopyState, type RepositoryRuns } from "../overview/items.ts";
import type { FolderNode } from "../project-workspace.ts";
import type { InboxPr } from "../pulls/model.ts";

export type ProjectView = "all" | "attention" | "changes" | "mine" | "ci-failed";
export const projectViews: ProjectView[] = ["all", "attention", "changes", "mine", "ci-failed"];
/** A copy as the page knows it: `place` is its machine and path; `state` is null when its status could not be read. */
export type TableCopy = {copyId: string; name: string; place: string; repository: string | null; category: string; state: CopyState | null};
export type TableInput = {copies: TableCopy[]; mine: InboxPr[]; runs: RepositoryRuns[]};
export type ProjectRow = {copyId: string; name: string; place: string; repository: string | null; category: string; branch: string | null;
  upstream: string | null; files: number | null; ahead: number; behind: number; pr: InboxPr | null; ci: Run | null; unreadable: boolean};

const lower = (text: string) => text.toLowerCase();
/** The forge path of a pull request (`team/web`) names a copy's repository when it is that repository's tail. */
export const sameRepository = (repository: string | null, path: string) => repository !== null
  && (lower(repository) === lower(path) || lower(repository).endsWith("/" + lower(path)));

const failed = (row: ProjectRow) => row.ci?.state === "failure" || row.pr?.ci === "failing";
const tests: Record<ProjectView, (row: ProjectRow) => boolean> = {
  all: () => true,
  attention: row => failed(row) || row.pr?.conflicts === true || row.pr?.reviewDecision === "CHANGES_REQUESTED" || row.behind > 0,
  changes: row => (row.files ?? 0) > 0 || (!row.unreadable && isUnpushed(row)),
  mine: row => row.pr !== null,
  "ci-failed": failed,
};

export function projectTable(input: TableInput): {rows: ProjectRow[]; counts: Record<ProjectView, number>} {
  const rows = input.copies.map((copy): ProjectRow => {
    const state = copy.state;
    const branch = state?.branch ?? null;
    const pr = branch === null ? null
      : input.mine.find(item => item.headRefName === branch && sameRepository(copy.repository, item.repo)) ?? null;
    // The runs of the copy's repository on the copy's own branch: another branch's failure is not this copy's.
    const runs = (input.runs.find(item => item.copyId === copy.copyId)
      ?? (copy.repository === null ? undefined : input.runs.find(item => item.repository === copy.repository)))?.runs ?? [];
    const ci = branch === null ? null : runs.filter(run => run.branch === branch)
      .reduce<Run | null>((newest, run) => !newest || runAt(run) > runAt(newest) ? run : newest, null);
    return {copyId: copy.copyId, name: copy.name, place: copy.place, repository: copy.repository, category: copy.category, branch,
      upstream: state?.upstream ?? null, files: state ? state.files : null, ahead: state?.ahead ?? 0, behind: state?.behind ?? 0,
      pr, ci, unreadable: state === null};
  });
  const counts = Object.fromEntries(projectViews.map(view => [view, rows.filter(tests[view]).length])) as Record<ProjectView, number>;
  return {rows, counts};
}

/**
 * Each copy's forge repository (`team/web`): CI/CD reads one copy per repository, so the other worktrees of that
 * repository (same `group`, the shared Git directory) take its repository too. A copy with none is left out.
 */
export function copyRepositories(runs: RepositoryRuns[], groupOf: Map<string, string>): Map<string, string> {
  const byGroup = new Map<string, string>();
  for (const entry of runs) { const group = groupOf.get(entry.copyId); if (group !== undefined) byGroup.set(group, entry.repository); }
  const result = new Map<string, string>();
  for (const [copyId, group] of groupOf) { const repository = byGroup.get(group); if (repository !== undefined) result.set(copyId, repository); }
  for (const entry of runs) result.set(entry.copyId, entry.repository);
  return result;
}

export const viewRows = (rows: ProjectRow[], view: ProjectView) => rows.filter(tests[view]);

/**
 * Each project's category: the top folder of the tree it sits under. One top folder holding projects of its own is the
 * projects folder itself: its projects take its name, and each folder below it is a category of its own.
 */
export function categoriesOf(folders: FolderNode[]): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (node: FolderNode, category: string) => {
    for (const row of node.rows) result.set(row.id, category);
    for (const child of node.children) walk(child, category);
  };
  const root = folders.length === 1 && folders[0]!.rows.length > 0 ? folders[0]! : null;
  if (root) {
    for (const row of root.rows) result.set(row.id, root.label);
    for (const child of root.children) walk(child, child.label);
  } else for (const folder of folders) walk(folder, folder.label);
  return result;
}
