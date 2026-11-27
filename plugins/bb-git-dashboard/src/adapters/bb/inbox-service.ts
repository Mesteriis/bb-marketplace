import { inboxTabs, type InboxPage, type InboxTab, type PullInbox } from "../../core/pulls/inbox.ts";
import type { InboxPr } from "../../core/pulls/model.ts";
import { diffWatch, type Alert, type WatchState } from "../../core/pulls/watch.ts";
import type { Account } from "../../core/providers.ts";
import { azureInbox } from "./forges/inbox/azure.ts";
import { giteaInbox } from "./forges/inbox/gitea.ts";
import { githubInbox } from "./forges/inbox/github.ts";
import { gitlabInbox } from "./forges/inbox/gitlab.ts";

export type InboxAlert = Alert & {accountId: string};
export type InboxGroup = {account: {id: string; label: string; kind: Account["kind"]}; items: InboxPr[]; notice: string | null; error: string | null};
type Credentials = {
  accounts(): Promise<Account[]>;
  credential(id: string): Promise<{account: Account; token: string}>;
  inbox?(account: Account, token: string): PullInbox;
};

export function inboxOf(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  if (account.kind === "github") return githubInbox(account, token, send);
  if (account.kind === "gitlab") return gitlabInbox(account, token, send);
  if (account.kind === "gitea") return giteaInbox(account, token, send);
  return azureInbox(account, token, send);
}
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";

/** One inbox tab over every connected account; an account that fails says why and the others still show. */
export function inboxService(deps: Credentials) {
  const open = async (id: string) => {
    const {account, token} = await deps.credential(id);
    return {account, inbox: (deps.inbox ?? inboxOf)(account, token)};
  };
  return {
    async list(tab: InboxTab) {
      const accounts = await deps.accounts();
      const groups = await Promise.all(accounts.map(async (account): Promise<InboxGroup & {counts: InboxPage["counts"]}> => {
        const summary = {id: account.id, label: account.label, kind: account.kind};
        try {
          const {inbox} = await open(account.id);
          const page = await inbox.list(tab);
          return {account: summary, items: page.items.map(item => ({...item, forge: account.kind, accountId: account.id})), notice: page.notice, error: null, counts: page.counts};
        } catch (error) {
          return {account: summary, items: [], notice: null, error: codeOf(error), counts: {}};
        }
      }));
      // A sum over some accounts would read as the whole: a tab any answering account cannot count gets no total.
      const answered = groups.filter(group => group.error === null);
      const counts: Partial<Record<InboxTab, number>> = {};
      for (const name of inboxTabs) {
        if (!answered.length || answered.some(group => group.counts[name] === undefined)) continue;
        counts[name] = answered.reduce((sum, group) => sum + group.counts[name]!, 0);
      }
      return {tab, counts, groups: groups.map(({counts: _counts, ...group}) => group)};
    },
  };
}

type Kv = {get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>};
export type WatchSettings = {ci: boolean; comments: boolean; ignore: string};

/**
 * One watcher round over every account. Each account keeps its own baseline, keyed by the viewer it was read as,
 * so a first poll, a new account or another login only records a baseline.
 */
export async function watchRound(deps: Credentials & {kv: Kv; now(): string}, settings: WatchSettings): Promise<InboxAlert[]> {
  const accounts = await deps.accounts();
  if (!settings.ci && !settings.comments) {
    for (const account of accounts) await deps.kv.delete("inbox-watch/" + account.id);
    return [];
  }
  const ignore = new Set(settings.ignore.split(",").map(name => name.trim().toLowerCase()).filter(Boolean));
  const alerts: InboxAlert[] = [];
  for (const account of accounts) {
    try {
      const {token} = await deps.credential(account.id);
      const watched = await (deps.inbox ?? inboxOf)(account, token).watch(ignore);
      if (!watched) continue;
      const key = "inbox-watch/" + account.id;
      const saved = await deps.kv.get<{viewer: string; state: Record<string, WatchState>}>(key);
      const previous = saved?.viewer === watched.viewer ? saved.state : null;
      const {alerts: fresh, next} = diffWatch(previous, watched.prs, deps.now(), {ci: settings.ci, comments: settings.comments});
      await deps.kv.set(key, {viewer: watched.viewer, state: next});
      alerts.push(...fresh.map(alert => ({...alert, accountId: account.id})));
    } catch { /* This account is retried next round; the others are not held up. */ }
  }
  return alerts;
}
