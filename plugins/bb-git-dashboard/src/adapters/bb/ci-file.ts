import type { Provider, Repo } from "../../core/providers.ts";
import type { RemoteAction } from "../../core/publication.ts";
import { failureFor } from "../../core/workspace.ts";

export type CiFileAction = Extract<RemoteAction, {kind: "ciFile"}>;

/** A write that failed after it had made the new branch: the branch stays, at `commit` when the file is in it. */
export class BranchLeft extends Error {
  readonly commit: string | null;
  constructor(code: string, commit: string | null) {
    super(code);
    this.commit = commit;
  }
}

/** Refuses a branch that is already there: a CI file goes only into a new one. */
async function assertNew(api: Provider, repo: Repo, branch: string) {
  if (branch === repo.branch) throw new Error("BRANCH_EXISTS");
  // The default branch was just read with the same account, so "not found" here means no such branch.
  const head = await api.branch(repo, branch).catch((error: unknown) => {
    if (error instanceof Error && ["NO_REMOTE_BRANCH", "PROVIDER_DENIED"].includes(error.message)) return null;
    throw error;
  });
  if (head) throw new Error("BRANCH_EXISTS");
}

/** What a CI file's confirmation shows, and the default branch's head the new branch will start from. */
export async function prepareCiFile(api: Provider, repo: Repo, action: CiFileAction) {
  if (repo.canPush === false) throw new Error("PROVIDER_DENIED");
  if (!repo.branch) throw new Error("NO_REMOTE_BRANCH");
  const base = await api.branch(repo, repo.branch);
  await assertNew(api, repo, action.branch);
  return {base, lines: ["Template · " + action.template, action.path + " · " + action.content.split("\n").filter(Boolean).length + " lines",
    repo.path + ":" + repo.branch + " @ " + base, "New branch · " + action.branch, action.title]};
}

export type CiFileOutcome = {status: "completed" | "accepted" | "failed" | "unknown"; code?: string; pullNumber?: number; notes: string[]};

/**
 * Writes the file into the new branch at the base the confirmation showed, then opens its pull request. A failure
 * before any branch exists is thrown; once a branch is there, the outcome names it, so it is not left unnoticed.
 */
export async function publishCiFile(api: Provider, repo: Repo, action: CiFileAction, base: string): Promise<CiFileOutcome> {
  const baseBranch = repo.branch;
  if (!baseBranch) throw new Error("NO_REMOTE_BRANCH");
  if (await api.branch(repo, baseBranch) !== base) throw new Error("STALE_HEAD");
  await assertNew(api, repo, action.branch);
  const left = (error: unknown, commit: string | null): CiFileOutcome => {
    const code = failureFor(error, "OUTCOME_UNKNOWN").code;
    return {status: code === "OUTCOME_UNKNOWN" ? "unknown" : "failed", code, notes: [commit
      ? "Branch " + action.branch + " was created at " + commit + "; check it, then open the pull request or delete the branch on the forge."
      : "Branch " + action.branch + " was created without the file; delete it on the forge before trying again."]};
  };
  let made: string;
  try { made = await api.createFile(repo, {branch: action.branch, base, baseBranch, path: action.path, content: action.content, message: action.title}); }
  catch (error) { if (error instanceof BranchLeft) return left(error, error.commit); throw error; }
  try {
    const result = await api.mutate(repo, {kind: "create", head: action.branch, base: baseBranch, expected: made, title: action.title, body: action.body});
    return {status: result.outcome, pullNumber: result.number, notes: []};
  } catch (error) { return left(error, made); }
}
