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
  alerts(): Promise<AlertSummary>;
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
