import { useTelegramLocale } from "./i18n/index.tsx";
import type { Chat } from "../core/demo.ts";
import { canonicalTelegramBotStartLink } from "../core/public-chat-reference.ts";
import { OpenTelegramMessageLink, TelegramMessageLink } from "./telegram-message-link.tsx";
import { useMiniAppLauncher } from "./mini-app.tsx";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ForumTopic, ForumTopicTarget, InlineBotPage, MediaReply, SendResult, TelegramPhoto } from "../core/contract.ts";

export type InlineBotActions = {
  search(id: string, username: string, query: string, offset?: string, topic?: ForumTopicTarget): Promise<InlineBotPage | null>;
  launchMiniApp?: (id: string, token: string, topic?: ForumTopicTarget) => Promise<{ url: string; session: string } | null>;
  preview?: (id: string, token: string) => Promise<TelegramPhoto | null>;
  send(id: string, token: string, topic?: ForumTopicTarget, reply?: MediaReply): Promise<SendResult>;
};

export const UseInlineBotDraft = createContext<((chatId: string, username: string, query?: string, reviewed?: boolean) => boolean) | undefined>(undefined);

export const UseInlineBotInOtherChat = createContext<((chat: Chat, username: string, query: string, topic?: ForumTopic) => boolean) | undefined>(undefined);

export function draftWithInlineBot(draft: string, username: string, query?: string, reviewed = false,
  confirmation = "Replace the current draft with the bot’s search query?"): string | undefined {
  if (!/^[a-z0-9_]{1,64}$/i.test(username)) return;
  const rest = draft.replace(/^@[a-z0-9_]{1,64}[ \t]+/i, "");
  const next = `@${username} ${query ?? rest}`;
  if (!reviewed && query !== undefined && draft.trim() && draft !== next
    && !window.confirm(confirmation)) return;
  if (next.length <= 4096) return next;
}

export function inlineBotRequest(draft: string) {
  const match = /^@([a-z0-9_]{1,64})[ \t]+([^\r\n]*)$/i.exec(draft);
  const query = match?.[2]?.trim();
  if (match && query !== undefined && query.length <= 256) return { username: match[1]!, query };
}

function InlineBotThumbnail({ chatId, token, load }: {
  chatId: string;
  token: string;
  load: NonNullable<InlineBotActions["preview"]>;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const [photo, setPhoto] = useState<TelegramPhoto>();
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let active = true;
    let started = false;
    function request() {
      if (started) return;
      started = true;
      void load(chatId, token).then((result) => { if (active && result) setPhoto(result); }, () => {});
    }
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) request();
    }) : undefined;
    if (observer) observer.observe(element);
    else request();
    return () => { active = false; observer?.disconnect(); };
  }, [chatId, load, token]);
  return <span ref={target} className="mtg-inline-bot-thumbnail">
    {photo && <img src={`data:${photo.mime};base64,${photo.base64}`} alt="" />}
  </span>;
}

export function InlineBotSearch({ chatId, username, query, search, send, preview, launchMiniApp, disabled }: {
  chatId: string;
  preview?: InlineBotActions["preview"];
  launchMiniApp?: (token: string) => Promise<{ url: string; session: string } | null>;
  username: string;
  query: string;
  search: (username: string, query: string, offset?: string) => Promise<InlineBotPage | null>;
  send: (token: string) => Promise<SendResult>;
  disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const followTelegram = useContext(OpenTelegramMessageLink);
  const useInlineBot = useContext(UseInlineBotDraft);
  const useOtherChat = useContext(UseInlineBotInOtherChat);
  const [page, setPage] = useState<InlineBotPage>();
  const miniApp = useMiniAppLauncher();
  const [status, setStatus] = useState<"loading" | "unavailable" | "error" | "sending" | "failed" | "unknown">();
  const active = useRef(false);
  const consumed = useRef(new Set<string>());
  const busy = status === "loading" || status === "sending";

  async function load(offset?: string) {
    if (active.current || disabled) return;
    active.current = true;
    setStatus("loading");
    try {
      const next = await search(username, query, offset);
      if (!next) setStatus("unavailable");
      else {
        setPage((previous) => ({ ...next, results: offset ? [...(previous?.results ?? []), ...next.results].slice(0, 250) : next.results }));
        setStatus(undefined);
      }
    } catch {
      setStatus("error");
    } finally {
      active.current = false;
    }
  }

  async function select(token: string) {
    if (active.current || disabled || consumed.current.has(token)) return;
    active.current = true;
    consumed.current.add(token);
    setStatus("sending");
    try {
      const result = await send(token);
      setStatus(result.state === "sent" ? undefined : result.state === "failed" ? "failed" : "unknown");
    } catch {
      setStatus("unknown");
    } finally {
      active.current = false;
    }
  }

  const startBot = page?.startBot && canonicalTelegramBotStartLink(page.startBot.url);
  return <div className="mtg-composer-media mtg-inline-bot-search" role="group" aria-label={tr("Inline bot results")} aria-busy={busy}>
    {(!page || status === "failed" || status === "unknown") &&
      <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => void load()}>{tr("Search @")}{username}
      </button>}
    {status === "loading" && <p role="status">{tr("Loading bot results…")}</p>}
    {status === "sending" && <p role="status">{tr("Sending bot result…")}</p>}
    {status === "unavailable" && <p role="status">{tr("This bot or chat does not support inline queries here.")}</p>}
    {status === "error" && <p role="status">{tr("Could not load bot results.")}</p>}
    {status === "failed" && <p role="status">{tr("Could not send that bot result. Search again for a fresh result.")}</p>}
    {status === "unknown" && <p role="status">{tr("Telegram did not confirm the send. Check the conversation before trying again.")}</p>}
    {page && !page.results.length && <p role="status">{tr("No bot results.")}</p>}
    {startBot && followTelegram && !disabled && !busy && <TelegramMessageLink url={startBot} follow={followTelegram}>
      {page?.startBot?.label}
    </TelegramMessageLink>}
    {page?.miniApp && launchMiniApp && <button type="button" className="mtg-action" disabled={disabled || busy} onClick={() => {
      const app = page.miniApp;
      if (app) miniApp.open({ target: { label: app.label }, launch: () => launchMiniApp(app.token),
        useCurrentChatQuery: useInlineBot ? (query) => useInlineBot(chatId, username, query, true) : undefined,
        useOtherChatQuery: useOtherChat ? (chat, query, topic) => useOtherChat(chat, username, query, topic) : undefined });
    }}>{page.miniApp.label}</button>}
    {miniApp.dialog}
    {!!page?.results.length && <ul>{page.results.map(({ token, title, description, kind, hasPreview }) => <li key={token}>
      <button type="button" className="mtg-action" disabled={disabled || busy || consumed.current.has(token)}
        onClick={() => void select(token)}>
        {hasPreview && preview && <InlineBotThumbnail chatId={chatId} token={token} load={preview} />}
        <span>{title} <small>{kind}{description ? ` · ${description}` : ""}</small></span>
      </button>
    </li>)}</ul>}
    {page?.next && page.results.length < 250 && <button type="button" className="mtg-action"
      disabled={disabled || busy} onClick={() => void load(page.next!)}>{tr("Load more bot results")}</button>}
  </div>;
}
