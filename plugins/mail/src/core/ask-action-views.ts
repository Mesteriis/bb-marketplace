// Ask AI with actions: a proposed action as the page runs it. The model
// names cited messages by number; here the numbers become the stored
// messages the plugin sent. An `act` keeps only messages that are in an
// Inbox now; an action left without a message is dropped.
import type { AiBuild } from "./ai-input.ts";
import type { AskAction } from "./ask-actions.ts";
import type { AskActionView } from "./model.ts";
import type { MailStore } from "./ports.ts";

export function askActionViews(
  store: Pick<MailStore, "getMessage" | "notifyRows">,
  actions: readonly AskAction[],
  parts: AiBuild["parts"],
  nowIso: string,
): AskActionView[] {
  const idOf = (n: number) => parts.find((part) => part.n === n)?.messageId ?? null;
  const out: AskActionView[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "search":
        out.push({ type: "search", query: action.query });
        break;
      case "compose":
        out.push({ type: "compose", paragraphs: action.paragraphs, linksRemoved: action.linksRemoved ?? 0 });
        break;
      case "reply": {
        const id = idOf(action.message);
        const header = id === null ? null : store.getMessage(id);
        if (header === null) break;
        out.push({
          type: "reply",
          messageId: header.id,
          accountId: header.accountId,
          threadId: header.threadId,
          paragraphs: action.paragraphs,
          linksRemoved: action.linksRemoved ?? 0,
        });
        break;
      }
      case "act": {
        const ids = action.messages.map(idOf).filter((id): id is string => id !== null);
        const groups = new Map<string, string[]>();
        for (const row of store.notifyRows(ids, nowIso)) {
          if (row.folderRole !== "inbox" || row.movePending !== null) continue;
          groups.set(row.accountId, [...(groups.get(row.accountId) ?? []), row.id]);
        }
        const list = [...groups].map(([accountId, messageIds]) => ({ accountId, messageIds }));
        const count = list.reduce((sum, group) => sum + group.messageIds.length, 0);
        if (count > 0) out.push({ type: "act", action: action.action, groups: list, count });
        break;
      }
    }
  }
  return out;
}
