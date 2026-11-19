// The owner's methods for Inbox tabs (Split Inbox): the tabs with their
// unread counts, saving, removing and reordering one, and the match a
// conversation list filters by.
import { TabsFullError, tabMatch, tabQueryProblem, type TabMatch, type TabQueryProblem } from "../../core/inbox-tabs.ts";
import type { SpecialUse } from "../../core/model.ts";
import type { MailStore } from "../../core/ports.ts";
import { refuse } from "./bb-rpc.ts";

export const TAB_PROBLEM_TEXT: Record<TabQueryProblem, string> = {
  empty: "A tab needs a condition",
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

    list({ scope, counts: wanted }: { scope: TabScope; counts?: boolean | undefined }) {
      const tabs = store.listInboxTabs();
      // Without tabs nothing shows a number: an owner who has none pays for no count.
      if (tabs.length === 0) return { inboxUnread: 0, tabs: [] };
      const now = deps.now();
      const matches = tabs.map((tab) => tabMatch(tab, tabs, now));
      // The Inbox tab is the tab of no condition; its count comes with the others.
      const whole: TabMatch = { kind: "all", conditions: [] };
      // Gmail's All Mail is never merged: no counts there.
      const counts =
        wanted === false || (scope.kind === "all" && scope.role === "all")
          ? [0, ...matches.map(() => 0)]
          : store.tabUnreadCounts(scope.kind === "account" ? { accountId: scope.accountId, folder: scope.folder } : { role: scope.role }, [whole, ...matches]);
      return {
        inboxUnread: counts[0] ?? 0,
        tabs: tabs.map((tab, i) => ({ id: tab.id, name: tab.name, query: tab.query, unread: counts[i + 1] ?? 0, broken: matches[i] === null })),
      };
    },

    save(input: { id?: string | undefined; name: string; query: string }) {
      const name = input.name.replace(/\s+/g, " ").trim();
      const query = input.query.trim();
      if (name === "") throw refuse("invalid", "A tab needs a name");
      const before = input.id === undefined ? undefined : store.listInboxTabs().find((tab) => tab.id === input.id);
      if (input.id !== undefined && before === undefined) throw refuse("not_found", UNKNOWN_TAB_TEXT);
      // A condition that stopped working stays as it is under a new name; a changed one must parse.
      const problem = before?.query === query ? null : tabQueryProblem(query, deps.now());
      if (problem !== null) throw refuse("invalid", TAB_PROBLEM_TEXT[problem]);
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
