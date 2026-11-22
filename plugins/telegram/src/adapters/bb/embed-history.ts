import { useMemo, useRef } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { historyMessageChangedChannel, historyMessageChangedEvent, messagesDeletedChannel, messagesDeletedSchema,
  type HistoryMessageChanged, type MessagesDeleted, type ResumedConversation } from "../../core/contract.ts";
import type { HistoryMessageUpdateActions } from "../../ui/history-message-updates.ts";
import type { BoundCall } from "./embed-conversation.tsx";

export function useEmbedHistory(connection: string, target: ResumedConversation | undefined, call: BoundCall): HistoryMessageUpdateActions {
  const edits = useRef(new Set<(event: HistoryMessageChanged) => void>());
  const deletions = useRef(new Set<(event: MessagesDeleted) => void>());
  useRealtime(historyMessageChangedChannel, raw => {
    const event = historyMessageChangedEvent.safeParse(raw).data;
    if (event && event.connectionId === connection && event.id === target?.chat.id)
      for (const notify of edits.current) notify(event);
  });
  useRealtime(messagesDeletedChannel, raw => {
    const event = messagesDeletedSchema.safeParse(raw).data;
    if (event && event.connectionId === connection && event.id === target?.chat.id)
      for (const notify of deletions.current) notify(event);
  });
  const topicId = target?.topic?.id;
  return useMemo(() => ({
    subscribe(listener) {
      edits.current.add(listener);
      return () => { edits.current.delete(listener); };
    },
    subscribeToDeletions(listener) {
      deletions.current.add(listener);
      return () => { deletions.current.delete(listener); };
    },
    load: (id, messageId) => call("historyMessage", { id, messageId, topicId }),
  }), [call, topicId]);
}
