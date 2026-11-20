import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ForwardedPost } from "../core/contract.ts";

type ForwardLocation = { chatId: string; messageId: string; topicId?: number };

export const OpenForwardedPost = createContext<((source: ForwardedPost, from: ForwardLocation, signal: AbortSignal) => Promise<boolean>) | undefined>(undefined);

export function ForwardedFrom({ name, source, from, action }: { name: string; source?: ForwardedPost; from: ForwardLocation; action?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const open = useContext(OpenForwardedPost);
  const request = useRef<AbortController | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "unavailable">();
  useEffect(() => () => request.current?.abort(), []);

  async function navigate() {
    if (!open || !source || status === "loading") return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    const found = await open(source, from, controller.signal).catch(() => false);
    if (!controller.signal.aborted) setStatus(found ? undefined : "unavailable");
  }

  if (action) return open && source ? <>
    <button className="mtg-action" type="button" disabled={status === "loading"} onClick={() => void navigate()}>
      <ExternalLink size={15} aria-hidden="true" />{tr("Open original post")}</button>
    {status === "unavailable" && <span role="status">{tr("Original post unavailable.")}</span>}
  </> : null;
  return <p className="mtg-forwarded">
    {name ? tr("Forwarded from ") : ""}
    {open && source ? <button className="mtg-forwarded-source" type="button" aria-label={tr("Open original post")}
      title={tr("Open original post")} disabled={status === "loading"} onClick={() => void navigate()}>
      {name ? <bdi>{name}</bdi> : tr("Forwarded message")}
    </button> : name ? <bdi>{name}</bdi> : tr("Forwarded message")}
    {status === "unavailable" && <span role="status">{tr(" Original post unavailable.")}</span>}
  </p>;
}
