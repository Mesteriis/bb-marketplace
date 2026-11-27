import { toList, toWatched, type RawSearch, type RawWatchPr } from "../../../../core/pulls/github.ts";
import type { InboxTab, PullInbox } from "../../../../core/pulls/inbox.ts";
import { inboxTabs } from "../../../../core/pulls/inbox.ts";
import { listQuery, WATCH_QUERY } from "../../../../core/pulls/queries.ts";
import type { Account } from "../../../../core/providers.ts";
import { client } from "../../provider-http.ts";
import { githubGraphql } from "../github-graphql.ts";
import { ownLink } from "./shared.ts";

/** The inbox of a GitHub account through GraphQL search, as bb-github-pr-dashboard reads it. */
export function githubInbox(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  const graphql = githubGraphql(account, client(account, token, send));
  return {
    async list(tab) {
      const data = await graphql<Partial<Record<InboxTab, RawSearch | null>>>(listQuery(tab));
      const own = data[tab];
      if (!own) throw new Error("PROVIDER_UNAVAILABLE");
      // A search GitHub left out (null in partial data) has no count rather than zero.
      const counts: Partial<Record<InboxTab, number>> = {};
      for (const name of inboxTabs) { const count = data[name]?.issueCount; if (typeof count === "number") counts[name] = count; }
      return {items: toList(own).items.filter(item => ownLink(account, item.url) !== null), counts, notice: null};
    },
    async watch(ignore) {
      const data = await graphql<{viewer: {login: string}; open: {nodes: (RawWatchPr | Record<string, never>)[]}}>(WATCH_QUERY);
      const prs = data.open.nodes.filter((item): item is RawWatchPr => "url" in item).map(item => toWatched(item, ignore))
        .filter(pr => ownLink(account, pr.url) !== null)
        .map(pr => pr.lastComment && !ownLink(account, pr.lastComment.url) ? {...pr, lastComment: {...pr.lastComment, url: pr.url}} : pr);
      return {viewer: data.viewer.login, prs};
    },
  };
}
