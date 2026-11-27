import type { Pr } from "./model.ts";
import type { Watched } from "./watch.ts";

export type InboxTab = "open" | "review" | "reviewed" | "assigned" | "merged" | "closed";
export const inboxTabs: InboxTab[] = ["open", "review", "reviewed", "assigned", "merged", "closed"];
export type InboxPage = {items: Pr[]; counts: Partial<Record<InboxTab, number>>; notice: string | null};

/** Pull requests one account takes part in, by tab, and what the watcher compares between polls. */
export interface PullInbox {
  list(tab: InboxTab): Promise<InboxPage>;
  /** Null where the forge cannot be watched. */
  watch(ignore: Set<string>): Promise<{viewer: string; prs: Watched[]} | null>;
}
