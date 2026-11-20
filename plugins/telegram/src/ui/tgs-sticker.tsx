import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AnimationItem } from "lottie-web";

export type LoadSticker = (chatId: string, messageId: string) => Promise<string>;
export const LoadTgsSticker = createContext<LoadSticker | undefined>(undefined);

export function TgsSticker({ chatId, messageId, load, fallback, inlineLabel, label, onPlaybackComplete }: {
  chatId: string; messageId: string; load: LoadSticker; fallback?: ReactNode; inlineLabel?: string; label?: string;
  onPlaybackComplete?: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const frame = useRef<HTMLSpanElement>(null);
  const player = useRef<HTMLSpanElement>(null);
  const animation = useRef<AnimationItem | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [requested, setRequested] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      setRequested(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting === true);
      if (entry?.isIntersecting) setRequested(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = player.current;
    if (!requested || !container) return;
    let active = true;
    void Promise.all([load(chatId, messageId), import("lottie-web/build/player/lottie_light_canvas.js")]).then(([json, lottie]) => {
      if (!active) return;
      const item = lottie.default.loadAnimation({ container, renderer: "canvas", loop: !onPlaybackComplete, autoplay: false,
        animationData: JSON.parse(json) });
      animation.current = item;
      item.addEventListener("DOMLoaded", () => { if (active) setReady(true); });
      const fail = () => { if (active) { setFailed(true); setReady(false); onPlaybackComplete?.(); } };
      if (onPlaybackComplete) item.addEventListener("complete", onPlaybackComplete);
      item.addEventListener("data_failed", fail);
      item.addEventListener("error", fail);
    }).catch(() => { if (active) { setFailed(true); onPlaybackComplete?.(); } });
    return () => {
      active = false;
      animation.current?.destroy();
      animation.current = undefined;
    };
  }, [chatId, messageId, load, requested, onPlaybackComplete]);

  useEffect(() => {
    const preference = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    function updatePlayback() {
      if (ready && visible && !preference?.matches) animation.current?.play();
      else animation.current?.pause();
    }
    updatePlayback();
    preference?.addEventListener("change", updatePlayback);
    return () => preference?.removeEventListener("change", updatePlayback);
  }, [ready, visible]);

  return <span ref={frame} className={`mtg-tgs-sticker${inlineLabel ? " mtg-custom-emoji" : ""}`}>
    <span ref={player} className="mtg-tgs-player" role="img" aria-label={label ?? inlineLabel ?? tr("Animated Telegram sticker")} aria-hidden={!ready} />
    {!ready && (fallback ?? <small role="status">{failed ? tr("Sticker unavailable") : tr("Loading sticker…")}</small>)}
  </span>;
}
