import type { PrAction } from "../../../../core/pulls/actions.ts";
import { toFiles, type RestFile } from "../../../../core/pulls/diff.ts";
import { toDetail, type RawDetail } from "../../../../core/pulls/github-detail.ts";
import { DRAFT_PR_MUTATION, PR_DETAIL_QUERY, READY_PR_MUTATION, REPLY_MUTATION, resolveThreadMutation } from "../../../../core/pulls/queries.ts";
import type { PullReview } from "../../../../core/pulls/review-port.ts";
import type { Account } from "../../../../core/providers.ts";
import { forgePrefix } from "../../forge-provider.ts";
import { array, client, object, segment } from "../../provider-http.ts";
import { githubGraphql } from "../github-graphql.ts";
import { ownLinks, repoParts } from "./shared.ts";

const maxFilePages = 30;

/** GitHub pull requests: detail through GraphQL, files and most writes through REST, thread and draft writes through GraphQL. */
export function githubReview(account: Account, token: string, path: string, send: typeof fetch = fetch): PullReview {
  const [owner, name] = repoParts(path);
  const http = client(account, token, send);
  const graphql = githubGraphql(account, http);
  const rest = forgePrefix(account) + "/repos/" + segment(owner) + "/" + segment(name);
  const write = (method: "POST" | "PATCH" | "PUT", target: string, body: unknown) => http(rest + target, {method, body});
  const anchor = (value: {path: string; line: number; side: "LEFT" | "RIGHT"; startLine: number | null}) => ({
    path: value.path, line: value.line, side: value.side,
    ...(value.startLine !== null && value.startLine !== value.line ? {start_line: value.startLine, start_side: value.side} : {}),
  });
  return {
    async detail(number) {
      const data = await graphql<{viewer: {login: string}; repository: {pullRequest: RawDetail | null} | null}>(PR_DETAIL_QUERY, {owner, name, number});
      const raw = data.repository?.pullRequest;
      if (!raw) throw new Error("NOT_FOUND");
      return ownLinks(account, toDetail(raw, data.viewer.login));
    },
    async files(number) {
      const rows: RestFile[] = [];
      for (let page = 1; page <= maxFilePages; page++) {
        const batch = array((await http(rest + "/pulls/" + number + "/files?per_page=100&page=" + page)).payload).map(object) as unknown as RestFile[];
        rows.push(...batch);
        if (batch.length < 100) break;
      }
      return toFiles(rows);
    },
    async act(number, action: PrAction, current) {
      const pull = "/pulls/" + number;
      switch (action.kind) {
        case "comment": await write("POST", "/issues/" + number + "/comments", {body: action.body}); break;
        case "reply": await graphql(REPLY_MUTATION, {threadId: action.threadId, body: action.body}, true); break;
        case "resolve": await graphql(resolveThreadMutation(action.resolved), {threadId: action.threadId}, true); break;
        case "lineComment": await write("POST", pull + "/comments", {body: action.body, commit_id: current.headSha, ...anchor(action)}); break;
        case "review":
          await write("POST", pull + "/reviews", {commit_id: current.headSha, event: action.event, body: action.body,
            comments: action.comments.map(comment => ({body: comment.body, ...anchor(comment)}))});
          break;
        case "requestReviewer": await write("POST", pull + "/requested_reviewers", {reviewers: [action.reviewer]}); break;
        case "editTitle": await write("PATCH", pull, {title: action.title}); break;
        case "editBody": await write("PATCH", pull, {body: action.body}); break;
        case "draft": await graphql(action.draft ? DRAFT_PR_MUTATION : READY_PR_MUTATION, {prId: current.id}, true); break;
        case "state": await write("PATCH", pull, {state: action.open ? "open" : "closed"}); break;
        case "merge": {
          const {payload} = await write("PUT", pull + "/merge", {sha: current.headSha, merge_method: action.method});
          if (object(payload).merged !== true) throw new Error("OUTCOME_UNKNOWN");
          break;
        }
      }
      return {outcome: "completed"};
    },
  };
}
