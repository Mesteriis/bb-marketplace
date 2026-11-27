import { randomUUID } from "node:crypto";
import { describeIssueAction, type IssueAction, type Issues } from "../../core/issues/model.ts";
import { describePrAction, type PrAction } from "../../core/pulls/actions.ts";
import { mergeMethods, pullCapabilities, pullLimitation, type PullOperation } from "../../core/pulls/capabilities.ts";
import type { PullReview } from "../../core/pulls/review-port.ts";
import type { Account } from "../../core/providers.ts";
import { giteaIssues } from "./forges/issues/gitea.ts";
import { githubIssues } from "./forges/issues/github.ts";
import { gitlabIssues } from "./forges/issues/gitlab.ts";
import { azureReview } from "./forges/review/azure.ts";
import { giteaReview } from "./forges/review/gitea.ts";
import { githubReview } from "./forges/review/github.ts";
import { gitlabReview } from "./forges/review/gitlab.ts";

const previewTtl = 5 * 60_000;
type Deps = {
  credential(accountId: string): Promise<{account: Account; token: string}>;
  review?(account: Account, token: string, path: string): PullReview;
  issues?(account: Account, token: string, path: string): Issues;
  now?(): number;
};

export function reviewOf(account: Account, token: string, path: string): PullReview {
  if (account.kind === "github") return githubReview(account, token, path);
  if (account.kind === "gitlab") return gitlabReview(account, token, path);
  if (account.kind === "gitea") return giteaReview(account, token, path);
  return azureReview(account, token, path);
}
export function issuesOf(account: Account, token: string, path: string): Issues {
  if (account.kind === "github") return githubIssues(account, token, path);
  if (account.kind === "gitlab") return gitlabIssues(account, token, path);
  if (account.kind === "gitea") return giteaIssues(account, token, path);
  throw new Error("PROVIDER_UNSUPPORTED");
}

/** The operation a write needs, to check it against the forge's matrix before anything is sent. */
function operationsOf(action: PrAction): PullOperation[] {
  if (action.kind === "review") return [...(action.event === "APPROVE" ? ["approve" as const] : action.event === "REQUEST_CHANGES" ? ["requestChanges" as const] : []),
    ...(action.comments.length ? ["lineComment" as const] : []), ...(action.event === "COMMENT" && !action.comments.length ? ["comment" as const] : [])];
  return [action.kind === "comment" ? "comment" : action.kind];
}

/**
 * Pull request and issue reads and confirmed writes, addressed by account, repository path and number so that they
 * work from My PRs without a working copy. A preview is confirmed once, within five minutes, and only while the
 * pull request's head is the one it was read with.
 */
export function reviewService(deps: Deps) {
  const now = deps.now ?? Date.now;
  const previews = new Map<string, {expires: number; run(): Promise<unknown>}>();
  async function open(accountId: string, path: string) {
    const {account, token} = await deps.credential(accountId);
    return {account, review: (deps.review ?? reviewOf)(account, token, path)};
  }
  function remember<T>(run: () => Promise<T>, lines: string[]) {
    for (const [key, value] of previews) if (value.expires < now()) previews.delete(key);
    const id = randomUUID();
    const expires = now() + previewTtl;
    previews.set(id, {expires, run});
    return {id, lines, expires: new Date(expires).toISOString()};
  }
  async function take<T>(previewId: string): Promise<T> {
    const preview = previews.get(previewId);
    previews.delete(previewId);
    if (!preview || preview.expires < now()) throw new Error("PREVIEW_EXPIRED");
    return await preview.run() as T;
  }
  return {
    async detail(accountId: string, path: string, number: number) {
      const {account, review} = await open(accountId, path);
      const forge = account.kind;
      const capabilities = pullCapabilities(forge);
      const limitations = Object.fromEntries(Object.keys(capabilities).flatMap(name => {
        const text = pullLimitation(forge, name as PullOperation);
        return text ? [[name, text]] : [];
      }));
      return {detail: await review.detail(number), capabilities, limitations, mergeMethods: mergeMethods(forge)};
    },
    async files(accountId: string, path: string, number: number) {
      return {files: await (await open(accountId, path)).review.files(number)};
    },
    async prepare(accountId: string, path: string, number: number, action: PrAction) {
      const {account, review} = await open(accountId, path);
      if (operationsOf(action).some(operation => !pullCapabilities(account.kind)[operation])) throw new Error("PROVIDER_UNSUPPORTED");
      if (action.kind === "merge" && !mergeMethods(account.kind).includes(action.method)) throw new Error("PROVIDER_UNSUPPORTED");
      const read = await review.detail(number);
      if (!read.headSha) throw new Error("STALE_HEAD");
      return remember(async () => {
        const current = await review.detail(number);
        if (current.headSha !== read.headSha) throw new Error("STALE_HEAD");
        return review.act(number, action, current);
      }, describePrAction({number, repo: path, headRefName: read.headRefName, baseRefName: read.baseRefName}, action));
    },
    confirm: (previewId: string) => take<{outcome: "completed" | "accepted"}>(previewId),
    async issueDetail(accountId: string, path: string, number: number) {
      const {account, token} = await deps.credential(accountId);
      return {issue: await (deps.issues ?? issuesOf)(account, token, path).detail(number)};
    },
    async issuePrepare(accountId: string, path: string, action: IssueAction) {
      const {account, token} = await deps.credential(accountId);
      if (account.kind === "azure") throw new Error("PROVIDER_UNSUPPORTED");
      const issues = (deps.issues ?? issuesOf)(account, token, path);
      return remember(() => issues.act(action), describeIssueAction(path, action));
    },
    issueConfirm: (previewId: string) => take<{number: number}>(previewId),
  };
}
