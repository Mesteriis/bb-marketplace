import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { ChatActivity } from "../core/contract.ts";

export type SubscribeToActivity = (listener: (activity: ChatActivity) => void) => () => void;

const labels = {
  typing: "Typing…",
  voice: "Recording a voice message…",
  video: "Recording a video…",
  uploading: "Uploading…",
};

export function ChatActivityIndicator({ chatId, topicId, subscribe }: {
  chatId: string;
  topicId?: number;
  subscribe: SubscribeToActivity;
}) {
  const { t: tr } = useTelegramLocale();
  const [active, setActive] = useState<Map<string, { activity: keyof typeof labels; until: number; progress?: number }>>(() => new Map());
  useEffect(() => subscribe((event) => {
    if (event.chatId !== chatId || event.topicId !== topicId) return;
    const key = `${event.sender.kind}:${event.sender.id}`;
    const until = Date.now() + 6000;
    setActive((previous) => {
      if (event.activity === "cancel" && !previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      if (event.activity !== "cancel") next.set(key, { activity: event.activity, until, progress: event.progress });
      if (next.size > 64) next.delete(next.keys().next().value!);
      return next;
    });
  }), [chatId, topicId, subscribe]);

  useEffect(() => {
    if (!active.size) return;
    const next = Math.min(...[...active.values()].map(({ until }) => until));
    const timer = setTimeout(() => {
      const now = Date.now();
      setActive((previous) => new Map([...previous].filter(([, entry]) => entry.until > now)));
    }, Math.max(1, next - Date.now()));
    return () => clearTimeout(timer);
  }, [active]);

  const latest = [...active.values()].at(-1);
  return latest && <p className="mtg-chat-activity" role="status">
    {active.size > 1 ? tr("{0} participants active…", [active.size])
      : latest.activity === "uploading" && latest.progress !== undefined ? tr("Uploading… {0}%", [latest.progress]) : tr(labels[latest.activity])}
  </p>;
}
