import { useEffect, useRef, useState } from "react";
import type { TelegramPhoto } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";

export type AvatarLoader = (id: string, fileId: number, user?: boolean) => Promise<TelegramPhoto>;

export function Avatar({ chat, load, user }: { chat: Pick<Chat, "id" | "color" | "initials" | "avatarJpeg" | "avatarFileId">; load?: AvatarLoader; user?: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const fileId = chat.avatarFileId;
  const avatarKey = `${user === true}:${chat.id}:${fileId}`;
  const [full, setFull] = useState<{ key: string; src: string }>();
  useEffect(() => {
    const element = target.current;
    if (!load || fileId === undefined || !element) return;
    const retryDelays = [350, 1200];
    let active = true;
    let visible = false;
    let loading = false;
    let loaded = false;
    let retries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const fetchAvatar = () => {
      if (!active || !visible || loading || loaded) return;
      loading = true;
      void (user ? load(chat.id, fileId, true) : load(chat.id, fileId)).then(({ mime, base64 }) => {
        if (!active) return;
        loaded = true;
        observer?.disconnect();
        setFull({ key: avatarKey, src: `data:${mime};base64,${base64}` });
      }, () => {
        loading = false;
        if (!active || !visible || retries >= retryDelays.length) return;
        retry = setTimeout(() => { retry = undefined; fetchAvatar(); }, retryDelays[retries++]);
      });
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      if (!active || !entries.length) return;
      const next = entries.some((entry) => entry.isIntersecting);
      if (next === visible) return;
      visible = next;
      if (visible) {
        retries = 0;
        fetchAvatar();
      } else {
        clearTimeout(retry);
        retry = undefined;
      }
    }) : undefined;
    if (observer) observer.observe(element);
    else {
      visible = true;
      fetchAvatar();
    }
    return () => { active = false; clearTimeout(retry); observer?.disconnect(); };
  }, [avatarKey, chat.id, fileId, load, user]);
  const [broken, setBroken] = useState<string>();
  const preview = chat.avatarJpeg ? `data:image/jpeg;base64,${chat.avatarJpeg}` : undefined;
  const photo = full?.key === avatarKey && full.src !== broken ? full.src : preview;
  return <span ref={target} className="mtg-avatar" style={{ backgroundColor: chat.color }} aria-hidden="true">
    {photo && photo !== broken
      ? <img alt="" src={photo} onError={() => setBroken(photo)} />
      : chat.initials}
  </span>;
}

export function MessageAuthor({ message, chat, load, search }: {
  message: Message;
  chat?: Chat;
  load?: AvatarLoader;
  search?: (button: HTMLButtonElement) => void;
}) {
  const profile = message.authorAvatar;
  const contact = !profile && !message.outgoing && chat?.subtitle === "Direct message" ? chat : undefined;
  const id = profile?.id ?? contact?.id ?? "";
  const fileId = profile?.fileId ?? contact?.avatarFileId;
  const initials = message.author.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return <div className="mtg-message-author">
    <Avatar key={`${profile?.user === true}:${id}:${fileId}`} user={profile?.user} load={load}
      chat={{ id, avatarFileId: fileId, avatarJpeg: profile?.preview ?? contact?.avatarJpeg,
        color: chat?.color ?? "#246dbd", initials }} />
    {search
      ? <button type="button" className="mtg-author-search" title="Search messages by this author"
        aria-label={`Search messages by ${message.author}`} onClick={(event) => search(event.currentTarget)}>
        <strong><bdi>{message.author}</bdi></strong>
      </button>
      : <strong><bdi>{message.author}</bdi></strong>}
  </div>;
}
