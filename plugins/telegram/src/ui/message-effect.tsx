import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { MessageEffectChoice, MessageEffectView } from "../core/contract.ts";
import { TgsSticker } from "./tgs-sticker.tsx";

export const LoadMessageEffect = createContext<((chatId: string, messageId: string, effectId: string,
  animate: boolean) => Promise<MessageEffectView | null>) | undefined>(undefined);

const motionPreference = "(prefers-reduced-motion: reduce)";
export type AutomaticMessageEffect = { claim: () => boolean };

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia(motionPreference).matches;
}

function visibleEffect(element: HTMLElement | null) {
  const row = element?.closest<HTMLElement>("[data-message-id]");
  const history = row?.closest<HTMLOListElement>(".mtg-history");
  if (!row || !history || history.hidden || document.visibilityState !== "visible"
    || document.querySelector("dialog:modal")) return false;
  const bounds = row.getBoundingClientRect();
  const viewport = history.getBoundingClientRect();
  return bounds.bottom > Math.max(0, viewport.top) && bounds.top < Math.min(window.innerHeight, viewport.bottom)
    && bounds.right > Math.max(0, viewport.left) && bounds.left < Math.min(window.innerWidth, viewport.right);
}

export function MessageEffectPicker({ chatId, load, selected, choose, disabled, subject = "message", menu }: {
  chatId: string;
  load: (chatId: string) => Promise<MessageEffectChoice[]>;
  selected?: MessageEffectChoice;
  choose: (effect?: MessageEffectChoice) => void;
  disabled: boolean;
  subject?: "message" | "album" | "forward";
  menu?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<MessageEffectChoice[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void load(chatId).then((result) => { if (current) setChoices(result); },
      () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [chatId, load, open]);

  function select(effect?: MessageEffectChoice) {
    choose(effect);
    setOpen(false);
    button.current?.focus();
  }

  return <span className="mtg-message-effect-picker" onKeyDown={(event) => {
    if (!open || event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  }}>
    <button ref={button} type="button" className="mtg-action" disabled={disabled} aria-expanded={open}
      aria-label={selected ? tr("Change {0} effect {1}", [tr(subject), selected.emoji])
        : subject === "forward" ? tr("Choose forward effect") : subject === "album" ? tr("Choose album effect") : tr("Choose message effect")} onClick={() => {
        if (!open) { setChoices(undefined); setFailed(false); }
        setOpen(!open);
      }}>{selected ? <span aria-hidden="true">{selected.emoji}</span> : <Sparkles size={17} aria-hidden="true" />}
      {menu && tr("Message effect")}
    </button>
    {open && <span className="mtg-message-effect-choices" role="group"
      aria-label={subject === "album" ? tr("Album effects") : subject === "forward" ? tr("Forward effects") : tr("Message effects")}>
      {!choices && !failed && <span role="status">{tr("Loading message effects…")}</span>}
      {failed && <span role="alert">{tr("Could not load message effects.")}</span>}
      {choices?.length === 0 && <span role="status">{tr("Message effects are unavailable in this chat.")}</span>}
      {choices?.map((effect) => {
        const labels = choices.filter(({ emoji }) => emoji === effect.emoji);
        const name = labels.length > 1 ? tr("{0} effect {1}", [effect.emoji, labels.indexOf(effect) + 1]) : tr("{0} effect", [effect.emoji]);
        const label = `${name}${effect.premium ? " · Premium" : ""}`;
        return <button key={effect.id} type="button" className="mtg-action" aria-label={label}
          aria-pressed={selected?.id === effect.id} disabled={disabled || !effect.available}
          onClick={() => select(effect)}>{effect.emoji}{effect.premium && <small aria-hidden="true"> Premium</small>}</button>;
      })}
      {selected && <button type="button" className="mtg-action" disabled={disabled} onClick={() => select()}>{tr("Remove effect")}</button>}
    </span>}
  </span>;
}

export function MessageEffect({ chatId, messageId, effectId, automatic }: {
  chatId: string; messageId: string; effectId: string; automatic?: AutomaticMessageEffect;
}) {
  const { t: tr } = useTelegramLocale();
  const load = useContext(LoadMessageEffect);
  const element = useRef<HTMLSpanElement>(null);
  const request = useRef<AbortController>(undefined);
  const automaticallyPlaying = useRef(false);
  const [status, setStatus] = useState<"loading" | "unavailable">();
  const [emoji, setEmoji] = useState<string>();
  const [animation, setAnimation] = useState<string>();
  const finish = useCallback(() => setAnimation(undefined), []);
  const playAnimation = useCallback(async () => animation ?? "", [animation]);
  useEffect(() => () => request.current?.abort(), []);
  const stopAutomatic = useCallback(() => {
    if (!automaticallyPlaying.current) return;
    automaticallyPlaying.current = false;
    request.current?.abort();
    request.current = undefined;
    finish();
    setStatus(undefined);
  }, [finish]);
  useEffect(() => {
    const media = typeof matchMedia === "function" ? matchMedia(motionPreference) : undefined;
    const change = () => { if (media?.matches) { stopAutomatic(); finish(); } };
    media?.addEventListener("change", change);
    return () => media?.removeEventListener("change", change);
  }, [finish, stopAutomatic]);

  const replay = useCallback(async (autoplay: boolean) => {
    if (request.current || !load || (autoplay && (reducedMotion() || !visibleEffect(element.current)))) return;
    const active = new AbortController();
    request.current = active;
    automaticallyPlaying.current = autoplay;
    finish();
    setStatus("loading");
    try {
      const animate = !reducedMotion();
      const effect = await load(chatId, messageId, effectId, animate);
      if (active.signal.aborted) return;
      if (effect) setEmoji(effect.emoji);
      if (effect?.animation && animate && !reducedMotion() && (!autoplay || visibleEffect(element.current))) setAnimation(effect.animation);
      setStatus(effect || autoplay ? undefined : "unavailable");
    } catch {
      if (!active.signal.aborted) setStatus(autoplay ? undefined : "unavailable");
    } finally {
      if (request.current === active) request.current = undefined;
    }
  }, [chatId, effectId, finish, load, messageId]);
  useEffect(() => {
    if (!automatic) { stopAutomatic(); return; }
    const visibility = () => { if (document.visibilityState !== "visible") stopAutomatic(); };
    document.addEventListener("visibilitychange", visibility);
    // Defer claiming until this mounted row has survived layout and effect setup.
    const frame = requestAnimationFrame(() => {
      if (automatic.claim()) void replay(true);
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [automatic, replay, stopAutomatic]);
  if (!load) return null;

  return <span ref={element} className="mtg-message-effect">
    <button type="button" className="mtg-action" aria-label={emoji ? tr("Replay {0} message effect", [emoji]) : tr("Play Telegram message effect")}
      aria-busy={status === "loading"} onClick={() => void replay(false)}>
      {emoji ? <span aria-hidden="true">{emoji}</span> : <Sparkles size={15} aria-hidden="true" />}
    </button>
    {animation && <span className="mtg-message-effect-overlay" aria-hidden="true">
      <TgsSticker chatId={chatId} messageId={messageId} load={playAnimation} onPlaybackComplete={finish} fallback={<></>} />
    </span>}
    {status === "unavailable" && <small className="mtg-message-effect-overlay" role="status">{tr("Message effect unavailable.")}</small>}
  </span>;
}
