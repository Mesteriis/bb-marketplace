// Ported from plugins/bb-github-pr-dashboard/queries.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// GitHub GraphQL text of the inbox tabs, the watcher, the pull request detail and the writes REST cannot do.

const CHECK_RUN = `name status conclusion detailsUrl startedAt
  checkSuite { app { name } workflowRun { workflow { name } } }`;

const BASE = `
  id number title url isDraft createdAt updatedAt mergedAt closedAt additions deletions
  author { login } baseRefName headRefName
  repository { nameWithOwner defaultBranchRef { name } }`;

// The PR whose head branch is this PR's base: the PR below it in a stack.
const STACK = "baseRef { associatedPullRequests(first: 1, states: OPEN) { nodes { number title url } } }";

// shortcut: only the first 100 review threads and check contexts per PR are
// read; paginate them if a PR ever needs more for an exact count.
const OPEN_DETAILS = `
  reviewDecision mergeable ${STACK}
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { state } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { ${CHECK_RUN} }
      ... on StatusContext { context state description targetUrl createdAt }
    } }
  } } } }`;

const MINE = "is:pr author:@me archived:false sort:updated-desc";
const OPEN_PRS = "is:pr is:open archived:false sort:updated-desc";

export type ListTab = "open" | "review" | "reviewed" | "assigned" | "merged" | "closed";

const TABS: Record<ListTab, { q: string; first: number; fields: string }> = {
  open: { q: `${MINE} is:open`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  review: { q: `${OPEN_PRS} review-requested:@me`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  // Reviewed by you and not asked again (a re-request lands in review); the head commit tells if your review went stale.
  reviewed: {
    q: `${OPEN_PRS} reviewed-by:@me -author:@me -review-requested:@me`,
    first: 50,
    fields: `${BASE} ${OPEN_DETAILS} headRefOid viewerLatestReview { state commit { oid } }`,
  },
  assigned: { q: `${OPEN_PRS} assignee:@me`, first: 50, fields: `${BASE} ${OPEN_DETAILS}` },
  merged: { q: `${MINE} is:merged`, first: 30, fields: BASE },
  closed: { q: `${MINE} is:closed is:unmerged`, first: 30, fields: BASE },
};
export const LIST_TABS = Object.keys(TABS) as ListTab[];

/** One tab's PRs, and only the count of every other tab (for the tab badges), in one request. */
export function listQuery(tab: ListTab): string {
  const searches = LIST_TABS.map((t) =>
    t === tab
      ? `${t}: search(query: "${TABS[t].q}", type: ISSUE, first: ${TABS[t].first}) { issueCount nodes { ... on PullRequest { ${TABS[t].fields} } } }`
      : `${t}: search(query: "${TABS[t].q}", type: ISSUE, first: 1) { issueCount }`,
  );
  return `query {\n  ${searches.join("\n  ")}\n}`;
}

/** Every merged or closed PR of yours, newest first, 100 a page, for the Repos filter and search on those tabs. */
export const HISTORY_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${BASE} } }
  }
}`;
export const historyQuery = (state: "merged" | "closed") => TABS[state].q;

const WHO = "author { __typename login } createdAt url";

// Open PRs only, with the latest few comments from every source so an
// ignored bot posting last cannot hide a person's comment.
export const WATCH_QUERY = `query {
  viewer { login }
  open: search(query: "${MINE} is:open", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      id number title url author { login } repository { nameWithOwner }
      comments(last: 5) { nodes { ${WHO} } }
      reviews(last: 5) { nodes { author { __typename login } submittedAt url } }
      reviewThreads(first: 100) { nodes { comments(last: 5) { nodes { ${WHO} } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { ${CHECK_RUN} }
        ... on StatusContext { context state description targetUrl createdAt }
      } } } } } }
    } }
  }
}`;

const COMMENT = "id viewerCanDelete author { login avatarUrl(size: 64) } body createdAt url";

// shortcut: first 100 threads, 50 comments per thread, last 100 comments and
// 50 reviews; paginate if a PR ever outgrows that.
export const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id number title url isDraft state createdAt body changedFiles additions deletions viewerCanUpdate
    author { login avatarUrl(size: 64) } headRefName headRefOid isCrossRepository baseRefName reviewDecision mergeable
    repository { nameWithOwner defaultBranchRef { name } } ${STACK}
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated viewerCanResolve viewerCanUnresolve path line originalLine startLine diffSide resolvedBy { login }
      comments(first: 50) { nodes { ${COMMENT} diffHunk state } }
    } }
    pendingReview: reviews(states: PENDING, first: 1) { nodes { id } }
    viewerLatestReview { commit { oid } }
    labels(first: 20) { nodes { name color } }
    latestReviews(first: 30) { nodes { author { login avatarUrl(size: 64) } state } }
    reviewRequests(first: 20) { nodes { requestedReviewer {
      __typename ... on User { login avatarUrl(size: 64) } ... on Bot { login avatarUrl(size: 64) }
      ... on Team { name avatarUrl(size: 64) } ... on Mannequin { login avatarUrl(size: 64) }
    } } }
    history: commits(last: 100) { totalCount nodes { commit {
      oid abbreviatedOid messageHeadline committedDate statusCheckRollup { state }
      author { name avatarUrl(size: 64) user { login } }
    } } }
    comments(last: 100) { nodes { ${COMMENT} } }
    reviews(last: 50) { nodes { author { login avatarUrl(size: 64) } state body submittedAt url } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { ${CHECK_RUN} title summary
        annotations(first: 20) { nodes { message path annotationLevel location { start { line } } } } }
      ... on StatusContext { context state description targetUrl createdAt }
    } } } } } }
  } }
}`;

// ---- Writes GitHub's REST API lacks: thread replies and resolution, draft state ----

/** GitHub deletes a discussion comment and a review comment through different mutations. */
export const deleteCommentMutation = (review: boolean) => review
  ? "mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }"
  : "mutation($id: ID!) { deleteIssueComment(input: { id: $id }) { clientMutationId } }";

export const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { url state }
  }
}`;

export const resolveThreadMutation = (resolve: boolean) => `mutation($threadId: ID!) {
  ${resolve ? "resolveReviewThread" : "unresolveReviewThread"}(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export const READY_PR_MUTATION = `mutation($prId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $prId }) { pullRequest { state } }
}`;

export const DRAFT_PR_MUTATION = `mutation($prId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $prId }) { pullRequest { state } }
}`;

// Only the field being edited is sent, so saving one never overwrites the other.
