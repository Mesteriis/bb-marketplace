import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isSavedMessagesQuery, publicChatReference } from "../../core/public-chat-reference.ts";
import { forumTopicId } from "../../core/contract.ts";
import { approvalRenderer, decisionSchema, draftSchema } from "../../core/agent-approval.ts";
import { approvalDeadline, approvalTimeoutMs, createApprovalQueue } from "./approval-queue.ts";
import type { TelegramToolRegistrar } from "./agent-cli.ts";
import type { createReplyTokens } from "./reply-tokens.ts";
import type { createTelegram } from "./telegram.ts";

export const agentSendTool = "makosh_telegram_request_send";

type Session = ReturnType<typeof createTelegram>;

export function registerAgentSend(
  bb: Pick<BbPluginApi, "ui"> & { agents: { registerTool: TelegramToolRegistrar } },
  enabled: () => Promise<boolean>,
  session: () => Session | undefined,
  replyTokens?: ReturnType<typeof createReplyTokens>,
  permissionSignal?: () => AbortSignal,
  approvals = createApprovalQueue(),
  replyPermissionSignal?: () => AbortSignal,
  accountLabel?: () => string | undefined,
  allowedReplyChats?: (session: Session) => Promise<readonly string[]>,
) {
  bb.agents.registerTool({
    name: agentSendTool,
    instructions: "Wait for the user to answer the BB confirmation form. Never submit or cancel the form on their behalf.",
    description: "Propose a plain-text Telegram message. Optionally suggest a recipient name, public @username or t.me link, Saved Messages, or an exact chat ID copied from BB. The user chooses the destination and confirms the exact text in BB. Use forumTopicId with recipientId to propose a new message in an exact forum or bot topic. Use a replyToken returned by an allowed read to propose a reply in the same chat. This tool does not return chat names or messages.",
    parameters: draftSchema.extend({
      recipientQuery: z.string().trim().min(2).max(128).optional(),
      recipientId: z.string().regex(/^-?[1-9]\d{0,15}$/).optional(),
      forumTopicId: forumTopicId.optional(),
      replyToken: z.uuid().optional(),
    }).strict(),
    async execute({ text, recipientQuery, recipientId, forumTopicId, replyToken }, { signal: toolSignal, threadId }) {
      const signals = [toolSignal];
      if (permissionSignal) signals.push(permissionSignal());
      if (replyToken && replyPermissionSignal) signals.push(replyPermissionSignal());
      const signal = AbortSignal.any(signals);
      if (signal.aborted || !await enabled() || signal.aborted) return "Telegram agent sending is disabled or cancelled.";
      if (recipientId && recipientQuery) return "Use either recipientId or recipientQuery. Nothing was sent.";
      if (forumTopicId !== undefined && (!recipientId || replyToken)) return "Use forumTopicId with recipientId and omit replyToken. Nothing was sent.";
      const current = session();
      if (current?.status().state !== "ready") return "Open Telegram in BB and connect the account first.";
      const release = approvals.acquire(threadId);
      if (!release) return "This chat already has a Telegram approval pending.";
      try {
        const target = replyToken ? replyTokens?.lookup(replyToken, current, threadId) : undefined;
        if (replyToken && (recipientQuery || recipientId || !target)) return "The Telegram reply target is invalid or expired. Nothing was sent.";
        const historyReplyAllowed = async () => target?.source !== "history" || !allowedReplyChats
          || (await allowedReplyChats(current)).includes(target.chat.id);
        if (!await historyReplyAllowed() || signal.aborted) return "Telegram reply access changed. Nothing was sent.";
        const username = publicChatReference(recipientQuery);
        if (username === null) return "Use a public Telegram @username or a t.me username link. Nothing was sent.";
        const exact = recipientId ? await current.chatById(recipientId) : username ? await current.publicChat(username) : undefined;
        if (username && !exact) return "The public Telegram chat is unavailable. Nothing was sent.";
        if (recipientId && exact?.id !== recipientId) return "The referenced Telegram recipient is unavailable. Nothing was sent.";
        const topicChat = target?.chat ?? exact;
        const topicId = target?.message.forumTopicId ?? forumTopicId;
        const topic = topicChat && topicId !== undefined
          ? await current.agentPostingTopic(topicChat.id, topicId, signal).catch(() => undefined) : undefined;
        if (topicId !== undefined && !topic) return "The Telegram forum topic is unavailable. Nothing was sent.";
        const chats = target ? [target.chat] : exact ? [exact] : recipientQuery
          ? isSavedMessagesQuery(recipientQuery) ? [await current.saved()] : await current.search(recipientQuery)
          : await current.chats();
        const senderNames = new Map<string, Promise<string>>();
        const resolveSender = (id: string) => {
          let lookup = senderNames.get(id);
          if (!lookup) {
            lookup = current.chatById(id)
              .then((chat) => chat?.id === id ? `${chat.name} · ID ${id}` : `Telegram chat ${id}`)
              .catch(() => `Telegram chat ${id}`);
            senderNames.set(id, lookup);
          }
          return lookup;
        };
        const recipients = (await Promise.all(chats.map(async (chat) => {
          const { id, name, subtitle } = chat;
          if ((subtitle === "Channel" || subtitle === "Group") && !await current.postingAllowed(id).catch(() => false)) return undefined;
          const senderKey = chat.senderKey ?? "account";
          const senderId = senderKey.startsWith("chat:") ? senderKey.slice(5) : undefined;
          const sender = senderId === id ? name : senderId ? await resolveSender(senderId) : "Your Telegram account";
          return { id, name, kind: subtitle, sender, senderKey, ...("archived" in chat && chat.archived === true ? { archived: true as const } : {}) };
        }))).filter((recipient) => recipient !== undefined);
        if (signal.aborted || recipients.length === 0) return "No Telegram recipient is available for approval.";
        if (!await enabled() || signal.aborted || session() !== current || current.status().state !== "ready") {
          return "Telegram session or settings changed. Nothing was sent.";
        }
        const speech = target?.message.speech;
        if (speech && !await current.speechReplyAvailable(target.chat.id, target.message.id, speech, topicId, signal).catch(() => false)) {
          return "The Telegram speech note changed or is unavailable. Nothing was sent.";
        }
        if (signal.aborted) return "Telegram reply access changed. Nothing was sent.";
        const review = approvalDeadline(signal);
        const label = accountLabel?.();
        const result = await bb.ui.requestInput({
          threadId, rendererId: approvalRenderer, title: "Approve Telegram message",
          timeoutMs: approvalTimeoutMs, payload: {
            text, recipients: recipients.map(({ senderKey: _, ...recipient }) => recipient),
            ...(label ? { accountLabel: label } : {}), ...(exact ? { showRecipientId: true } : {}),
            ...(target ? { replyPreview: target.message.text } : {}), ...(speech ? { replyKind: speech.kind } : {}),
            ...(topic ? { forumTopic: topic } : {}),
          },
          describeSubmission: () => ({ title: "Reviewed Telegram message" }),
        }, { signal: review.signal });
        if (result.outcome !== "submitted") return "Telegram request cancelled. Nothing was sent.";
        const choice = decisionSchema.safeParse(result.value);
        const recipient = choice.success ? recipients.find(({ id }) => id === choice.data.id) : undefined;
        if (!recipient) {
          return "Telegram approval was invalid. Nothing was sent.";
        }
        if (!review.active()) return "Telegram approval expired or was revoked. Nothing was sent.";
        if (!await enabled() || !await historyReplyAllowed() || !review.active() || session() !== current || current.status().state !== "ready") {
          return "Telegram session or settings changed. Nothing was sent.";
        }
        let rejectedBeforeDispatch = false;
        let authorizedDispatch = false;
        // TDLib checks the reply and posting rights asynchronously. Recheck
        // the live authorization after those checks, at the actual send.
        const authorizeDispatch = () => {
          const active = review.active() && session() === current && current.status().state === "ready";
          const validReply = active && (!target || (replyToken && replyTokens?.lookup(replyToken, current, threadId)
            && replyTokens.consume(replyToken)));
          rejectedBeforeDispatch = !validReply;
          authorizedDispatch = !!validReply;
          return authorizedDispatch;
        };
        const sender = { key: recipient.senderKey, name: recipient.name, kind: recipient.kind };
        const context: [typeof topic?, "history"?] = target?.source === "history" ? [topic, "history"] : topic ? [topic] : [];
        const sent = await current.sendText(recipient.id, text, target?.message.id, speech ?? target?.message.text,
          authorizeDispatch, sender, ...context);
        if (rejectedBeforeDispatch) return "Telegram approval expired or was revoked. Nothing was sent.";
        if (sent.state === "sent") return "Telegram confirmed the message was sent.";
        if (!authorizedDispatch && topic) return "The approved Telegram topic or reply is no longer available. Nothing was sent.";
        if (sent.state === "failed") return "Telegram rejected the message.";
        return "Telegram did not confirm delivery. Check the conversation before retrying.";
      } catch {
        return "The Telegram request could not be completed. Check BB before retrying.";
      } finally {
        release();
      }
    },
  });
}
