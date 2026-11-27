import type { Pr } from "./model.ts";
import type { Watched } from "./watch.ts";

export type InboxTab = "open" | "review" | "reviewed" | "assigned" | "merged" | "closed";
export const inboxTabs: InboxTab[] = ["open", "review", "reviewed", "assigned", "merged", "closed"];
export type InboxPage = {items: Pr[]; counts: Partial<Record<InboxTab, number>>; notice: string | null};

/** Pull requests one account takes part in, by tab, and what the watcher compares between polls. */
export interface PullInbox {
  list(tab: InboxTab): Promise<InboxPage>;
  /**
   * Every merged or closed pull request, newest first, up to HISTORY_LIMIT, for search on those tabs; `total` is what
   * the forge counts. Absent where the forge's tab already reads its whole list.
   */
  history?(state: "merged" | "closed"): Promise<{items: InboxPage["items"]; total: number}>;
  /** Null where the forge cannot be watched. */
  watch(ignore: Set<string>): Promise<{viewer: string; prs: Watched[]} | null>;
}

/** The most merged or closed pull requests a history search reads: GitHub's search returns no more than 1 000. */
export const HISTORY_LIMIT = 1_000;
