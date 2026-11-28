// The Projects page's table: a row per attached copy with its pull request and newest run, and the views over them. No I/O.
import type { Run } from "../ci/model.ts";
import { isUnpushed, runAt, type CopyState, type RepositoryRuns } from "../overview/items.ts";
import type { FolderNode } from "../project-workspace.ts";
import type { InboxPr } from "../pulls/model.ts";

export type ProjectView = "all" | "attention" | "changes" | "mine" | "ci-failed";
export const projectViews: ProjectView[] = ["all", "attention", "changes", "mine", "ci-failed"];
/** A copy as the page knows it; `state` is null when its status could not be read. */
export type TableCopy = {copyId: string; name: string; repository: string | null; category: string; state: CopyState | null};
export type TableInput = {copies: TableCopy[]; mine: InboxPr[]; runs: RepositoryRuns[]};
export type ProjectRow = {copyId: string; name: string; repository: string | null; category: string; branch: string | null;
  upstream: string | null; files: number | null; ahead: number; behind: number; pr: InboxPr | null; ci: Run | null; unreadable: boolean};

const lower = (text: string) => text.toLowerCase();
/** The forge path of a pull request (`team/web`) names a copy's repository when it is that repository's tail. */
const sameRepository = (repository: string | null, path: string) => repository !== null
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
    const runs = input.runs.find(item => item.copyId === copy.copyId)?.runs ?? [];
    const ci = runs.reduce<Run | null>((newest, run) => !newest || runAt(run) > runAt(newest) ? run : newest, null);
    return {copyId: copy.copyId, name: copy.name, repository: copy.repository, category: copy.category, branch,
      upstream: state?.upstream ?? null, files: state ? state.files : null, ahead: state?.ahead ?? 0, behind: state?.behind ?? 0,
      pr, ci, unreadable: state === null};
  });
  const counts = Object.fromEntries(projectViews.map(view => [view, rows.filter(tests[view]).length])) as Record<ProjectView, number>;
  return {rows, counts};
}

export const viewRows = (rows: ProjectRow[], view: ProjectView) => rows.filter(tests[view]);

/** Each project's category: the label of the top folder of the tree it sits under. */
export function categoriesOf(folders: FolderNode[]): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (node: FolderNode, category: string) => {
    for (const row of node.rows) result.set(row.id, category);
    for (const child of node.children) walk(child, category);
  };
  for (const folder of folders) walk(folder, folder.label);
  return result;
}
