import { HistoryMessageUpdates, type HistoryMessageUpdateActions } from "../../ui/history-message-updates.ts";
import { useMemo, useState, type ComponentProps } from "react";
import type { z } from "zod";
import { schemas, type ResumedConversation } from "../../core/contract.ts";
import { createAccountDrafts, type AccountDrafts } from "../../ui/local-drafts.ts";
import { TelegramPage } from "../../ui/telegram-page.tsx";
import { documentSender } from "./document-delivery-client.ts";

type Live = NonNullable<NonNullable<ComponentProps<typeof TelegramPage>>["live"]>;
type Method = z.infer<typeof schemas.embedChatAction.input>["method"];
export type BoundCall = <K extends Method>(method: K, payload: z.input<(typeof schemas)[K]["input"]>) => Promise<z.output<(typeof schemas)[K]["output"]>>;
const inlineDetails = { details: null, openDetails: () => false };

export function EmbedConversation({ target, call, revision, updates, draftStorage }: { target: ResumedConversation; call: BoundCall; revision: number; updates?: HistoryMessageUpdateActions; draftStorage?: AccountDrafts }) {
  const [drafts] = useState(() => draftStorage ?? createAccountDrafts());
  const [localRevision, setLocalRevision] = useState(0);
  const [list, selectList] = useState(target.list);
  const live = useMemo<Live>(() => {
    const { chat, topic } = target;
    const topicId = topic?.id;
    return {
      chats: list === target.list ? [chat] : [], list, selectList, folders: [], loading: false, error: "", liveRevision: revision + localRevision,
      findChats: async (query, at) => at === target.list && chat.name.toLowerCase().includes(query.toLowerCase()) ? [chat] : [],
      refresh: () => setLocalRevision(n => n + 1),
      subscribeToDeletions: updates?.subscribeToDeletions,
      loadHistory: (id, before) => call("history", { id, before, topicId }),
      loadPeerProfile: id => call("peerProfile", { id }),
      sendText: (id, text, replyTo, delivery) => topic
        ? call("sendTopicText", { id, text, replyTo, topic, styles: delivery?.styles, quote: delivery?.quote, delivery })
        : call("send", { id, text, replyTo, delivery }),
      sendDocument: documentSender(input => call("prepareDocumentUpload", { ...input, topic })),
      loadChatDraft: id => topicId ? call("topicDraft", { id, topicId }) : call("chatDraft", { id }),
      saveChatDraft: (id, draft, expected) => call("saveChatDraft", { id, draft, expected, topicId }),
    };
  }, [target, call, revision, localRevision, list, updates]);
  return <div className="mtg-embed-conversation">{target.topic && <p>{target.topic.name}</p>}
    <HistoryMessageUpdates.Provider value={updates}><TelegramPage live={live} boundChat={target.chat} draftStorage={drafts} workspace={inlineDetails} /></HistoryMessageUpdates.Provider></div>;
}
