import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CustomEmojiMedia } from "../core/contract.ts";
import { TgsSticker } from "./tgs-sticker.tsx";

type LoadCustomEmoji = (id: string) => Promise<CustomEmojiMedia | null>;
export const CustomEmojiLoader = createContext<LoadCustomEmoji | undefined>(undefined);

export function InlineCustomEmoji(props: { id: string; label: string; load: LoadCustomEmoji }) {
  return <StickerArtwork key={props.id} {...props} inline />;
}

export function DecorativeCustomEmoji({ id, className }: { id?: string; className?: string }) {
  const load = useContext(CustomEmojiLoader);
  if (!id || !load) return null;
  return <span aria-hidden="true" className={className}><InlineCustomEmoji id={id} label="" load={load} /></span>;
}

export function StickerArtwork({ id, label, load, inline }: { id: string; label: string; load: LoadCustomEmoji; inline?: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef(false);
  const [media, setMedia] = useState<CustomEmojiMedia>();
  const [visible, setVisible] = useState(false);
  const loadTgs = useCallback(async () => {
    if (media?.format !== "tgs") throw new Error("Sticker is unavailable.");
    return media.json;
  }, [media]);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let active = true;
    function enter(inside: boolean) {
      setVisible(inside);
      if (!inside || pending.current) return;
      pending.current = true;
      void load(id).then((result) => { if (active && result) setMedia(result); }).catch(() => {});
    }
    if (typeof IntersectionObserver !== "function") {
      enter(true);
      return () => { active = false; pending.current = false; };
    }
    const observer = new IntersectionObserver(([entry]) => enter(entry?.isIntersecting === true));
    observer.observe(element);
    return () => { active = false; pending.current = false; observer.disconnect(); };
  }, [id, load]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const preference = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    function syncPlayback() {
      if (!element) return;
      if (visible && !preference?.matches) void element.play().catch(() => {});
      else element.pause();
    }
    syncPlayback();
    preference?.addEventListener("change", syncPlayback);
    return () => preference?.removeEventListener("change", syncPlayback);
  }, [media, visible]);

  return <span ref={target} className={inline ? "mtg-custom-emoji" : "mtg-welcome-sticker"}>
    {media?.format === "tgs" ? <TgsSticker chatId="" messageId={id} inlineLabel={inline ? label : undefined}
      label={label} load={loadTgs} fallback={label} />
      : media?.format === "webp" ? <img src={`data:image/webp;base64,${media.base64}`} alt={label} onError={() => setMedia(undefined)} />
      : media?.format === "webm" ? <video ref={video} aria-label={label} role="img" muted loop playsInline
        src={`data:video/webm;base64,${media.base64}`} onError={() => setMedia(undefined)} />
      : label}
  </span>;
}
