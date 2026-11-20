import { randomUUID } from "node:crypto";
import type { createTelegram, SpeechReplyProof } from "./telegram.ts";

type ReplyTarget = {
  session: ReturnType<typeof createTelegram>;
  threadId: string;
  source?: "history";
  chat: { id: string; name: string; subtitle: string; senderKey?: string };
  message: { id: string; text: string; forumTopicId?: number; speech?: SpeechReplyProof };
};

export function createReplyTokens(now = Date.now) {
  const values = new Map<string, ReplyTarget & { expires: number }>();
  return {
    issue(target: ReplyTarget) {
      const token = randomUUID();
      if (values.size >= 128) values.delete(values.keys().next().value!);
      values.set(token, { ...target, expires: now() + 10 * 60_000 });
      return token;
    },
    lookup(token: string, session: ReplyTarget["session"], threadId: string) {
      const target = values.get(token);
      if (!target || target.session !== session || target.threadId !== threadId) return undefined;
      if (target.expires > now()) return target;
      values.delete(token);
      return undefined;
    },
    consume(token: string) { return values.delete(token); },
    clear() { values.clear(); },
  };
}
