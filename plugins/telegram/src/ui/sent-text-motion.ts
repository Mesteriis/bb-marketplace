import { useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../core/demo.ts";
import { isAwayFromLatest } from "./history-scroll.ts";

function motionEnabled() {
  return !document.hidden && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function useSentTextMotion(scope: string) {
  const generation = useRef(0);
  const next = useRef<{ timeline: HTMLElement; from: DOMRect; id: string; generation: number } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const animation = useRef<Animation | undefined>(undefined);
  const [revision, setRevision] = useState(0);

  useLayoutEffect(() => () => {
    generation.current++;
    next.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    animation.current?.cancel();
    frame.current = undefined;
    animation.current = undefined;
  }, [scope]);

  useLayoutEffect(() => {
    const request = next.current;
    next.current = undefined;
    if (!request) return;
    const { timeline, from, id } = request;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (generation.current !== request.generation || !motionEnabled() || !timeline.isConnected
        || timeline.hidden || timeline.dataset.hasNewer === "true") return;
      const row = timeline.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      const bubble = row?.querySelector<HTMLElement>(":scope > .mtg-bubble") ?? row;
      if (!bubble || typeof bubble.animate !== "function") return;
      const to = bubble.getBoundingClientRect();
      const viewport = timeline.getBoundingClientRect();
      if (!to.width || !to.height || !viewport.width || !viewport.height
        || to.bottom <= viewport.top || to.top >= viewport.bottom) return;
      // Transforms outside the scrollport can extend the scrollable area.
      const x = Math.max(Math.min(0, viewport.left - to.left), Math.min(from.left - to.left, Math.max(0, viewport.right - to.right)));
      const y = Math.max(Math.min(0, viewport.top - to.top), Math.min(from.top - to.top, Math.max(0, viewport.bottom - to.bottom)));
      animation.current?.cancel();
      animation.current = bubble.animate([
        { transform: `translate(${x}px, ${y}px)`, opacity: 0.55 },
        { transform: "none", opacity: 1 },
      ], { duration: 180, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" });
    });
  }, [revision]);

  return (composer: HTMLElement | null, timeline: HTMLElement | null) => {
    if (!composer || !timeline || !motionEnabled() || timeline.dataset.hasNewer === "true" || isAwayFromLatest(timeline)) return;
    const from = composer.getBoundingClientRect();
    if (!from.width || !from.height) return;
    const current = generation.current;
    const capturedAt = performance.now();
    return (message: Message) => {
      if (generation.current !== current || !timeline.isConnected || message.failedDelivery || message.pendingDelivery
        || !/^[1-9]\d{0,15}$/.test(message.id) || performance.now() - capturedAt > 1500) return;
      next.current = { timeline, from, id: message.id, generation: current };
      setRevision((value) => value + 1);
    };
  };
}
