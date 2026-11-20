import { useEffect, useRef } from "react";

export type SetTypingActivity = (chatId: string, typing: boolean, topicId?: number) => Promise<boolean>;

export function useTypingActivity(chatId: string, send: SetTypingActivity | undefined, topicId?: number) {
  const controller = useRef<{ touch(): void; stop(): void } | undefined>(undefined);
  const queued = useRef(Promise.resolve());

  useEffect(() => {
    if (!chatId || !send) return;
    const dispatch = send;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let last = -Infinity;
    let active = false;
    let announced = false;
    let generation = 0;

    function stop() {
      clearTimeout(expiry);
      if (!active) return;
      active = false;
      generation++;
      last = -Infinity;
      queued.current = queued.current.then(async () => {
        if (!announced) return;
        announced = false;
        await Promise.resolve().then(() => dispatch(chatId, false, topicId)).catch(() => false);
      });
    }

    controller.current = {
      touch() {
        if (document.visibilityState === "hidden") return;
        clearTimeout(expiry);
        expiry = setTimeout(stop, 5000);
        active = true;
        const now = Date.now();
        if (now - last < 4000) return;
        last = now;
        const request = generation;
        queued.current = queued.current.then(async () => {
          if (!active || request !== generation) return;
          announced = await Promise.resolve().then(() => dispatch(chatId, true, topicId)).catch(() => false) || announced;
        });
      },
      stop,
    };
    function visibilityChanged() {
      if (document.visibilityState === "hidden") stop();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stop();
      controller.current = undefined;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [chatId, send, topicId]);

  return {
    changed(value: string) {
      if (value.trim()) controller.current?.touch();
      else controller.current?.stop();
    },
    stop() { controller.current?.stop(); },
  };
}
