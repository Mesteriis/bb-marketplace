// The owner's methods for Inbox tabs (Split Inbox): the tabs with their
// unread counts, saving, removing and reordering one, and the match a
// conversation list filters by.
import { TabsFullError, tabMatch, tabQueryProblem, type TabMatch, type TabQueryProblem } from "../../core/inbox-tabs.ts";
import type { SpecialUse } from "../../core/model.ts";
import type { MailStore } from "../../core/ports.ts";
import { refuse } from "./bb-rpc.ts";

export const TAB_PROBLEM_TEXT: Record<TabQueryProblem, string> = {
  empty: "A tab needs a condition",
  free_text: "A tab's condition uses search operators only",
  unknown_operator: "Unknown operator in the condition",
  bad_value: "A value in the condition is not valid",
  too_long: "The condition is too long",
};
export const TABS_FULL_TEXT = "You have the most tabs Mail keeps (12)";
export const UNKNOWN_TAB_TEXT = "Unknown tab";

export type TabScope = { kind: "account"; accountId: string; folder: string } | { kind: "all"; role: SpecialUse };

export function createInboxTabsRpc(deps: { store: MailStore; now: () => Date; newId: () => string }) {
  const { store } = deps;
  return {
    /** The match of a tab for a conversation list: undefined for no tab or one that is gone (the whole Inbox), null for a broken one. */
    matchOf(tabId: string | undefined): TabMatch | null | undefined {
      if (tabId === undefined) return undefined;
      const tabs = store.listInboxTabs();
      const tab = tabs.find((t) => t.id === tabId);
      return tab === undefined ? undefined : tabMatch(tab, tabs, deps.now());
    },

    list({ scope }: { scope: TabScope }) {
      const tabs = store.listInboxTabs();
      const now = deps.now();
      const matches = tabs.map((tab) => tabMatch(tab, tabs, now));
      // Gmail's All Mail is never merged: no counts there.
      const counts =
        scope.kind === "all" && scope.role === "all"
          ? matches.map(() => 0)
          : store.tabUnreadCounts(scope.kind === "account" ? { accountId: scope.accountId, folder: scope.folder } : { role: scope.role }, matches);
      return {
        tabs: tabs.map((tab, i) => ({ id: tab.id, name: tab.name, query: tab.query, unread: counts[i] ?? 0, broken: matches[i] === null })),
      };
    },

    save(input: { id?: string | undefined; name: string; query: string }) {
      const name = input.name.replace(/\s+/g, " ").trim();
      const query = input.query.trim();
      if (name === "") throw refuse("invalid", "A tab needs a name");
      const problem = tabQueryProblem(query, deps.now());
      if (problem !== null) throw refuse("invalid", TAB_PROBLEM_TEXT[problem]);
      if (input.id !== undefined && !store.listInboxTabs().some((tab) => tab.id === input.id)) throw refuse("not_found", UNKNOWN_TAB_TEXT);
      try {
        const tab = store.saveInboxTab({ id: input.id ?? deps.newId(), name, query }, deps.now().toISOString());
        return { tab: { id: tab.id, name: tab.name, query: tab.query } };
      } catch (error) {
        if (error instanceof TabsFullError) throw refuse("conflict", TABS_FULL_TEXT);
        throw error;
      }
    },

    remove({ id }: { id: string }) {
      store.deleteInboxTab(id);
      return { ok: true as const };
    },

    move({ id, direction }: { id: string; direction: "left" | "right" }) {
      store.moveInboxTab(id, direction === "left" ? -1 : 1);
      return { ok: true as const };
    },
  };
}

export type InboxTabsRpc = ReturnType<typeof createInboxTabsRpc>;
