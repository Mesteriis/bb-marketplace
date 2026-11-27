import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useMemo, useRef } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { CopyState, OverviewInput, RepositoryRuns } from "../core/overview/items.ts";
import type { InboxPr } from "../core/pulls/model.ts";
import type { Copy } from "../core/workspace.ts";
import type { OverviewApi, OverviewData, OverviewSource } from "../ui/overview/overview-api.ts";
import { refPath } from "../ui/review/review-api.ts";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
const copyLimit = 50;
const parallel = 6;
// This session's last read: the overview opens from it, and Refresh reads every source again.
let session: {key: string; data: Promise<OverviewData>} | null = null;

/** Runs `work` over `items` with at most `limit` at a time, in order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

async function read(client: Client, copies: Copy[], projects: number): Promise<OverviewData> {
  const failed: OverviewSource[] = [];
  // A tab of My PRs: every account's items; an account that did not answer makes the source partial.
  const tab = async (name: "open" | "review" | "merged", source: OverviewSource): Promise<InboxPr[]> => {
    const result = await client.call("inboxList", {tab: name}).catch(() => null);
    if (!result?.ok) { failed.push(source); return []; }
    if (result.groups.some(group => group.error)) failed.push(source);
    return result.groups.flatMap(group => group.items);
  };
  const runs = async (): Promise<RepositoryRuns[]> => {
    const result = await client.call("ciOverview", {}).catch(() => null);
    if (!result?.ok) { failed.push("ci"); return []; }
    if (result.repositories.some(repository => repository.error)) failed.push("ci");
    return result.repositories.map(({copyId, repository, runs}) => ({copyId, repository, runs}));
  };
  let copiesFailed = 0;
  const states = async (): Promise<CopyState[]> => {
    const read = await pool(copies.slice(0, copyLimit), parallel, async (copy): Promise<CopyState | null> => {
      const result = await client.call("git", {copyId: copy.id, action: {kind: "status"}}).catch(() => null);
      if (!result?.ok) { copiesFailed++; return null; }
      const status = result.value;
      return {copyId: copy.id, name: copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root, branch: status.branch ?? null,
        ahead: status.ahead ?? 0, behind: status.behind ?? 0, at: null};
    });
    if (copiesFailed) failed.push("copies");
    return read.filter((state): state is CopyState => state !== null);
  };
  const [mine, requested, merged, repositoryRuns, copyStates] = await Promise.all([tab("open", "mine"), tab("review", "requested"),
    tab("merged", "merged"), runs(), states()]);
  const input: OverviewInput = {mine, requested, merged, runs: repositoryRuns, copies: copyStates, now: Date.now()};
  return {input, failed, copiesFailed, projects, at: Date.now()};
}

/** The overview's data and actions over the plugin's RPC: My PRs, CI/CD and the status of the attached copies. */
export function useOverviewApi(copies: Copy[], projects: number): OverviewApi {
  const client = useRpc<typeof rpc>();
  const navigate = useBbNavigate();
  const latest = useRef({copies, projects});
  latest.current = {copies, projects};
  const key = copies.map(copy => copy.id).join(",");
  return useMemo<OverviewApi>(() => ({
    load(refresh) {
      if (refresh || !session || session.key !== key) {
        const data = read(client, latest.current.copies, latest.current.projects);
        session = {key, data};
        data.catch(() => { if (session?.data === data) session = null; });
      }
      return session.data;
    },
    open(target) {
      navigate.toPluginPanel("git", {subPath: target.kind === "pr" ? refPath("pr", target)
        : target.copyId + (target.section === "actions" ? "/actions" : "")});
    },
    saveView(view) { void client.call("interfaceSet", {overviewView: view}).catch(() => {}); },
    Link: ({href, children}) => <UrlLink href={href} className="g-btn ghost">{children}</UrlLink>,
  }), [client, navigate, key]);
}
