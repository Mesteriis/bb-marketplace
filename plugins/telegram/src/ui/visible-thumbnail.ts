import { useEffect, useState, type RefObject } from "react";
import type { TelegramPhoto } from "../core/contract.ts";

export type VisibleThumbnailLoader = (chatId: string, messageId: string) => Promise<TelegramPhoto | null>;

export function useVisibleThumbnail(target: RefObject<Element | null>, chatId: string, messageId: string, load?: VisibleThumbnailLoader) {
  const [photo, setPhoto] = useState<TelegramPhoto>();
  useEffect(() => {
    const element = target.current;
    if (!load || !element || typeof IntersectionObserver !== "function") return;
    let active = true;
    let requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (requested || !active || !entries.some(({ isIntersecting, intersectionRatio }) => isIntersecting && intersectionRatio > 0)) return;
      requested = true;
      observer.disconnect();
      void load(chatId, messageId).then((image) => {
        if (active && image) setPhoto(image);
      }, () => undefined);
    });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [chatId, messageId, load, target]);
  return { photo, discard: () => setPhoto(undefined) };
}
