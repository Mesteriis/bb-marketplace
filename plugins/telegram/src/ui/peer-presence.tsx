import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { PeerPresenceEvent, UserPresence } from "../core/contract.ts";

export type SubscribeToPresence = (listener: (event: PeerPresenceEvent) => void) => () => void;

export function PeerPresence({ id, load, subscribe }: {
  id: string;
  load: (id: string) => Promise<UserPresence>;
  subscribe?: SubscribeToPresence;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [presence, setPresence] = useState<UserPresence>({ state: "unavailable" });

  useEffect(() => {
    let active = true;
    let sequence = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    function show(next: UserPresence) {
      clearTimeout(expiry);
      if (next.state === "online") {
        const delay = next.expires * 1000 - Date.now();
        if (delay <= 0) {
          setPresence({ state: "unavailable" });
          return;
        }
        expiry = setTimeout(() => {
          setPresence({ state: "unavailable" });
          refresh();
        }, Math.min(delay, 2_147_483_647));
      }
      setPresence(next);
    }
    function refresh() {
      const request = ++sequence;
      void load(id).then((next) => {
        if (active && request === sequence) show(next);
      }, () => {});
    }
    const unsubscribe = subscribe?.((event) => {
      if (event.chatId !== id) return;
      sequence++;
      show(event.presence);
    });
    refresh();
    const renew = setInterval(refresh, 90_000);
    return () => {
      active = false;
      clearInterval(renew);
      clearTimeout(expiry);
      unsubscribe?.();
    };
  }, [id, load, subscribe]);

  if (presence.state === "offline") {
    const time = new Date(presence.lastSeen * 1000);
    return <p>{tr("Last seen ")}<time dateTime={time.toISOString()}>{time.toLocaleString(uiLocale)}</time></p>;
  }
  const labels = { online: "Online", recently: "Last seen recently", week: "Last seen within a week",
    month: "Last seen within a month", bot: "Bot", unavailable: "Direct message" };
  return <p>{tr(labels[presence.state])}</p>;
}
