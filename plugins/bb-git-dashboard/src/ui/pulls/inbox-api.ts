import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { inboxAlert, inboxContract, inboxPr } from "../../core/pulls/contract.ts";
import type { InboxTab } from "../../core/pulls/inbox.ts";

export type InboxItem = z.infer<typeof inboxPr>;
export type InboxAlert = z.infer<typeof inboxAlert>;
type Ok<T> = Omit<Extract<z.infer<T>, {ok: true}>, "ok">;
export type InboxList = Ok<typeof inboxContract.inboxList.output>;
export type AlertSummary = Ok<typeof inboxContract.inboxAlerts.output>;
export type InboxApi = {
  list(tab: InboxTab): Promise<InboxList>;
  /** Merged or closed with the whole history the forge reads, for search on those tabs. */
  history(tab: "merged" | "closed"): Promise<Pick<InboxList, "groups">>;
  alerts(): Promise<AlertSummary>;
  /** A link to the plugin's settings, where the alerts are set up. */
  SettingsLink?: ComponentType<{children: ReactNode}>;
  seen(): Promise<AlertSummary>;
};

export const tabLabels: Record<InboxTab, string> = {
  open: "Open", review: "Review requested", reviewed: "Reviewed", assigned: "Assigned", merged: "Merged", closed: "Closed",
};
export const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;

/** How bad the worst blocker is: red stops the merge, amber waits on someone, none is ready. */
export function severity(item: InboxItem): "red" | "amber" | "none" {
  if (item.mergedAt || item.closedAt) return "none";
  if (item.conflicts || item.ci === "failing" || item.reviewDecision === "CHANGES_REQUESTED") return "red";
  return item.blockers.length ? "amber" : "none";
}

/** Rows in the order the page shows them: by account, then repository, newest first within each. */
export function grouped(list: InboxList, matches: (item: InboxItem) => boolean, hidden: Set<string>) {
  return list.groups.map(group => {
    const repos = new Map<string, InboxItem[]>();
    for (const item of [...group.items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      if (!matches(item)) continue;
      const key = group.account.id + "|" + item.repo;
      if (hidden.has(key)) continue;
      repos.set(item.repo, [...repos.get(item.repo) ?? [], item]);
    }
    return {...group, repos: [...repos.entries()].map(([repo, items]) => ({repo, key: group.account.id + "|" + repo, items}))};
  });
}

/** The Open tab's tiles: what fails, what waits on comments or changes, and what nothing blocks. */
export function openStats(items: readonly InboxItem[]) {
  const count = (test: (item: InboxItem) => boolean) => items.filter(test).length;
  return {ciFailing: count(item => item.ci === "failing"), unresolved: count(item => item.unresolvedThreads > 0),
    changesRequested: count(item => item.reviewDecision === "CHANGES_REQUESTED"), ready: count(item => item.blockers.length === 0)};
}

/** How long ago `at` (ms) was, in the largest whole unit. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86_400) return Math.floor(seconds / 3600) + " h ago";
  return Math.floor(seconds / 86_400) + " d ago";
}

/** Whether a list shows only its newest rows; null when it shows all the forge counts, or the forge does not count. */
export function showing(shown: number, total: number | null, searchable: boolean): string | null {
  if (total === null || shown >= total) return null;
  return "Showing the " + shown + " most recently updated of " + total + "." + (searchable ? " Search to reach the older ones." : "");
}

/** Where Open on an alert goes in Makosh Git: its pull request, or My PRs for an alert of no pull request (the test). */
export function alertPath(alert: Pick<InboxAlert, "accountId" | "repo" | "number">): string {
  return alert.number > 0 && alert.accountId && alert.repo ? ["pr", alert.accountId, String(alert.number), alert.repo].join("/") : "inbox";
}

/** The count on Makosh Git's navigation entry: unseen alerts, while "show the unread count" is on. */
export function alertBadge(summary: AlertSummary | null): {count: number; tone: "critical"; label: string} | null {
  if (!summary?.badge || summary.unseen <= 0) return null;
  return {count: summary.unseen, tone: "critical", label: summary.unseen + " new pull request alert" + (summary.unseen === 1 ? "" : "s")};
}
