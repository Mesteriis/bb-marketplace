import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useMemo, useRef } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { CopyState, RepositoryRuns } from "../core/overview/items.ts";
import type { InboxPr } from "../core/pulls/model.ts";
import type { Copy } from "../core/workspace.ts";
import type { OverviewApi, OverviewData, OverviewSource } from "../ui/overview/overview-api.ts";
import { refPath } from "../ui/review/review-api.ts";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
const copyLimit = 50;
const parallel = 6;
const fresh = 5 * 60_000;
// This session's last complete read: the overview reopens from it for a few minutes; a partial read is not kept.
let session: {key: string; at: number; data: Promise<OverviewData>} | null = null;
let mergedSession: {at: number; data: Promise<InboxPr[] | null>} | null = null;

/** Runs `work` over `items` with at most `limit` at a time, in order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

/** A tab of My PRs over every account; `failed` when it or an account did not answer. */
async function tab(client: Client, name: "open" | "review" | "merged"): Promise<{items: InboxPr[]; failed: boolean}> {
  const result = await client.call("inboxList", {tab: name}).catch(() => null);
  if (!result?.ok) return {items: [], failed: true};
  return {items: result.groups.flatMap(group => group.items), failed: result.groups.some(group => group.error)};
}

async function read(client: Client, copies: Copy[]): Promise<OverviewData> {
  const failed: OverviewSource[] = [];
  const runs = async (): Promise<RepositoryRuns[]> => {
    const result = await client.call("ciOverview", {}).catch(() => null);
    if (!result?.ok) { failed.push("ci"); return []; }
    if (result.repositories.some(repository => repository.error)) failed.push("ci");
    return result.repositories.map(({copyId, repository, runs}) => ({copyId, repository, runs}));
  };
  let copiesFailed = 0;
  const shown = copies.slice(0, copyLimit);
  const states = async (): Promise<CopyState[]> => {
    const read = await pool(shown, parallel, async (copy): Promise<CopyState | null> => {
      const result = await client.call("git", {copyId: copy.id, action: {kind: "status"}}).catch(() => null);
      if (!result?.ok) { copiesFailed++; return null; }
      const status = result.value;
      return {copyId: copy.id, name: copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root, branch: status.branch ?? null,
        upstream: status.upstream ?? null, ahead: status.ahead ?? 0, behind: status.behind ?? 0, at: null};
    });
    if (copiesFailed) failed.push("copies");
    return read.filter((state): state is CopyState => state !== null);
  };
  const [mine, requested, repositoryRuns, copyStates] = await Promise.all([tab(client, "open"), tab(client, "review"), runs(), states()]);
  if (mine.failed) failed.unshift("mine");
  if (requested.failed) failed.splice(mine.failed ? 1 : 0, 0, "requested");
  return {input: {mine: mine.items, requested: requested.items, runs: repositoryRuns, copies: copyStates, now: Date.now()},
    failed, copiesFailed, copies: shown.length, limited: copies.length > copyLimit ? copyLimit : null, at: Date.now()};
}

/** The overview's data and actions over the plugin's RPC: My PRs, CI/CD and the status of the attached copies. */
export function useOverviewApi(copies: Copy[]): OverviewApi {
  const client = useRpc<typeof rpc>();
  const navigate = useBbNavigate();
  const latest = useRef(copies);
  latest.current = copies;
  const key = copies.map(copy => copy.id).join(",");
  return useMemo<OverviewApi>(() => ({
    load(refresh) {
      if (refresh || !session || session.key !== key || Date.now() - session.at > fresh) {
        const data = read(client, latest.current);
        const entry = {key, at: Date.now(), data};
        session = entry;
        // Only a complete read is kept for the session; a partial one is read again next time.
        data.then(value => { if (value.failed.length && session === entry) session = null; }, () => { if (session === entry) session = null; });
      }
      return session.data;
    },
    merged(refresh) {
      if (refresh || !mergedSession || Date.now() - mergedSession.at > fresh) {
        const data = tab(client, "merged").then(result => result.failed ? null : result.items);
        const entry = {at: Date.now(), data};
        mergedSession = entry;
        data.then(value => { if (value === null && mergedSession === entry) mergedSession = null; });
      }
      return mergedSession.data;
    },
    open(target) {
      navigate.toPluginPanel("git", {subPath: target.kind === "pr" ? refPath("pr", target) : target.kind === "ci" ? "ci"
        : target.copyId + (target.section === "actions" ? "/actions" : "")});
    },
    async saveView(view) {
      const result = await client.call("interfaceSet", {overviewView: view});
      if (!result.ok) throw new Error(result.code);
    },
    Link: ({href, children}) => <UrlLink href={href} className="g-btn ghost">{children}</UrlLink>,
  }), [client, navigate, key]);
}
