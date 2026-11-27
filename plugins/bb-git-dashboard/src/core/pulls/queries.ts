// Ported from plugins/bb-github-pr-dashboard/queries.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// GitHub GraphQL text of the inbox tabs and the watcher; the pull request detail query arrives with 0.7.0.

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
