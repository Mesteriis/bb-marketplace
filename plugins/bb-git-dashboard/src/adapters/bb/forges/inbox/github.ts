import { toList, toWatched, type RawSearch, type RawWatchPr } from "../../../../core/pulls/github.ts";
import type { InboxTab, PullInbox } from "../../../../core/pulls/inbox.ts";
import { inboxTabs } from "../../../../core/pulls/inbox.ts";
import { listQuery, WATCH_QUERY } from "../../../../core/pulls/queries.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, text } from "../../provider-http.ts";

/** github.com answers at api.github.com/graphql, GitHub Enterprise Server at <origin>/api/graphql. */
const endpoint = (account: Account) => ["github.com", "api.github.com"].includes(new URL(account.origin).hostname) ? "/graphql" : "/api/graphql";

/** The inbox of a GitHub account through GraphQL search, as bb-github-pr-dashboard reads it. */
export function githubInbox(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  const http = client(account, token, send);
  async function graphql<T>(query: string): Promise<T> {
    const {payload} = await http(endpoint(account), {method: "POST", read: true, maxBytes: 8 * 1024 * 1024, body: {query}});
    const answer = object(payload);
    const errors = array(answer.errors).map(object);
    if (errors.length && !answer.data) {
      throw new Error(errors.some(error => ["FORBIDDEN", "INSUFFICIENT_SCOPES"].includes(text(error.type))) ? "PROVIDER_DENIED" : "PROVIDER_REJECTED");
    }
    return answer.data as T;
  }
  return {
    async list(tab) {
      const data = await graphql<Record<InboxTab, RawSearch>>(listQuery(tab));
      const counts = Object.fromEntries(inboxTabs.map(name => [name, data[name]?.issueCount ?? 0])) as Record<InboxTab, number>;
      return {items: toList(data[tab]).items, counts, notice: null};
    },
    async watch(ignore) {
      const data = await graphql<{viewer: {login: string}; open: {nodes: (RawWatchPr | Record<string, never>)[]}}>(WATCH_QUERY);
      return {viewer: data.viewer.login, prs: data.open.nodes.filter((item): item is RawWatchPr => "url" in item).map(item => toWatched(item, ignore))};
    },
  };
}
