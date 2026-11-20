import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useEffect, useRef, useState, type ReactNode } from "react";

export type FollowTelegramMessageLink = (url: string, signal: AbortSignal, options?: { refreshStickerPack: true }) => Promise<boolean>;
export const OpenTelegramMessageLink = createContext<FollowTelegramMessageLink | undefined>(undefined);

export function TelegramMessageLink({ url, children, follow }: {
  url: string;
  children: ReactNode;
  follow: FollowTelegramMessageLink;
}) {
  const { t: tr } = useTelegramLocale();
  const request = useRef<AbortController | undefined>(undefined);
  const [status, setStatus] = useState<"opening" | "unavailable">();
  useEffect(() => () => { request.current?.abort(); }, [url]);

  async function open() {
    if (request.current && !request.current.signal.aborted) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("opening");
    const opened = await follow(url, controller.signal).catch(() => false);
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = undefined;
    setStatus(opened ? undefined : "unavailable");
  }

  return <>
    <a href={url} target="_blank" rel="noopener noreferrer" aria-busy={status === "opening"} onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void open();
    }}>{children}</a>
    {status === "unavailable" && <span role="status">{tr(" Telegram link unavailable.")}</span>}
  </>;
}
