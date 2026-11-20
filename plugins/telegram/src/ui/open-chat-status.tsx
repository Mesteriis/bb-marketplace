import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { GroupOnlineEvent } from "../core/contract.ts";

export type SetOpenChatView = (id: string, view: string, open: boolean) => Promise<number | null>;
export type SubscribeToGroupOnline = (listener: (event: GroupOnlineEvent) => void) => () => void;

export function OpenChatStatus({ id, setView, subscribe, label }: {
  id: string;
  setView: SetOpenChatView;
  subscribe?: SubscribeToGroupOnline;
  label?: string;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [online, setOnline] = useState<number | null>(null);
  useEffect(() => {
    const view = crypto.randomUUID();
    let active = true;
    let sequence = 0;
    let shown = document.visibilityState !== "hidden";
    let queue = Promise.resolve();

    function update(open: boolean) {
      const revision = ++sequence;
      queue = queue.then(async () => {
        if (open && (!active || !shown)) return;
        const next = await setView(id, view, open).catch(() => null);
        if (active && shown && revision === sequence) setOnline(next);
      });
    }

    const unsubscribe = subscribe?.((event) => {
      if (event.chatId !== id || !active || !shown) return;
      sequence++;
      setOnline(event.online);
    });
    function changeVisibility() {
      shown = document.visibilityState !== "hidden";
      if (!shown) setOnline(null);
      update(shown);
    }

    if (shown) update(true);
    const timer = setInterval(() => { if (shown) update(true); }, 15_000);
    document.addEventListener("visibilitychange", changeVisibility);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", changeVisibility);
      unsubscribe?.();
      update(false);
    };
  }, [id, setView, subscribe]);

  if (!label) return null;
  return <p>{online === null ? label : tr("{0} online", [online.toLocaleString(uiLocale)])}</p>;
}
