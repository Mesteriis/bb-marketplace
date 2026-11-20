import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { HistoryMessageChanged, MessagesDeleted } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";

export type HistoryMessageUpdateActions = {
  subscribeToDeletions?: (listener: (event: MessagesDeleted) => void) => () => void;
  subscribe: (listener: (event: HistoryMessageChanged) => void) => () => void;
  load: (chatId: string, messageId: string, topicId?: number) => Promise<Message | null>;
};
export const HistoryMessageUpdates = createContext<HistoryMessageUpdateActions | undefined>(undefined);

export function useHistoryMessageUpdates(chatId: string, topicId: number | undefined, enabled: boolean,
  hasMessage: (id: string) => boolean, accept: (message: Message) => void) {
  const actions = useContext(HistoryMessageUpdates);
  const current = useRef({ actions, chatId, topicId, enabled, hasMessage, accept });
  useLayoutEffect(() => {
    current.current = { actions, chatId, topicId, enabled, hasMessage, accept };
  }, [actions, chatId, topicId, enabled, hasMessage, accept]);
  useEffect(() => {
    if (!enabled || !chatId || !actions) return;
    let active = true;
    const pending = new Map<string, boolean>();
    const isCurrent = () => active && current.current.actions === actions && current.current.chatId === chatId
      && current.current.topicId === topicId && current.current.enabled;
    async function refresh(messageId: string) {
      pending.set(messageId, false);
      try {
        const row = await actions!.load(chatId, messageId, topicId);
        if (isCurrent() && !pending.get(messageId) && current.current.hasMessage(messageId)
          && row?.id === messageId && (topicId === undefined || row.forumTopicId === topicId)) current.current.accept(row);
      } catch {
        // Leave the loaded row visible if Telegram cannot retrieve the edit yet.
      } finally {
        const changed = pending.get(messageId);
        pending.delete(messageId);
        if (isCurrent() && changed && current.current.hasMessage(messageId)) void refresh(messageId);
      }
    }
    const unsubscribe = actions.subscribe(({ id, messageId }) => {
      if (!isCurrent() || id !== chatId || !current.current.hasMessage(messageId)) return;
      if (pending.has(messageId)) pending.set(messageId, true);
      else void refresh(messageId);
    });
    const unsubscribeDeletions = actions.subscribeToDeletions?.(({ id, retained }) => {
      if (!isCurrent() || id !== chatId) return;
      for (const row of retained ?? []) {
        if (current.current.hasMessage(row.id) && (topicId === undefined || row.forumTopicId === topicId)) current.current.accept(row);
      }
    });
    return () => { active = false; unsubscribe(); unsubscribeDeletions?.(); };
  }, [actions, chatId, enabled, topicId]);
}
