/** A pinned pull request's tab params: pins from 0.14.7 keep the repository's path, older ones its id only. */
export type PullPin = {accountId: string; repo: string | null; repoId: string | null; number: number};

/** Reads a pinned pull request's params; null when they do not name an account, a repository and a number. */
export function pullPin(params: unknown): PullPin | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  const repo = typeof value.repo === "string" && value.repo ? value.repo : null;
  const repoId = typeof value.repoId === "string" && value.repoId ? value.repoId : null;
  if (typeof value.accountId !== "string" || typeof value.number !== "number" || (!repo && !repoId)) return null;
  return {accountId: value.accountId, repo, repoId, number: value.number};
}

/** One pull request: the same account and number, and the same repository path (any case) or the same repository id. */
export function samePull(a: PullPin, b: PullPin): boolean {
  if (a.accountId !== b.accountId || a.number !== b.number) return false;
  if (a.repo && b.repo) return a.repo.toLowerCase() === b.repo.toLowerCase();
  return a.repoId !== null && a.repoId === b.repoId;
}
