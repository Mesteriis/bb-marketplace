import { useTelegramLocale } from "./i18n/index.tsx";
import { TelegramChatPickerDialog, useMiniAppLauncher, type CloseMiniAppSession } from "./mini-app.tsx";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { BotButtonAnswer, ForumTopic, ForumTopicPage, ForumTopicTarget, InlineBotButton } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { UseInlineBotDraft, UseInlineBotInOtherChat } from "./inline-bot-search.tsx";
import { botButtonLink } from "../core/telegram-content-link.ts";
import { miniAppFrameEvent, miniAppFrameUrl } from "../core/mini-app.ts";
import { MessageForward, type ForwardActions } from "./message-forward.tsx";
import { DecorativeCustomEmoji } from "./custom-emoji.tsx";
import { OpenTelegramMessageLink } from "./telegram-message-link.tsx";

type CallbackButton = Extract<InlineBotButton, { kind: "callback" }>;
type PressButton = (chatId: string, messageId: string, button: CallbackButton) => Promise<BotButtonAnswer>;
export const PressInlineBotButton = createContext<PressButton | undefined>(undefined);

type ProfileButton = Extract<InlineBotButton, { kind: "profile" }>;
export type LoadInlineBotProfile = (chatId: string, messageId: string, button: ProfileButton) => Promise<Chat | null>;
export const OpenInlineBotProfile = createContext<((chatId: string, messageId: string,
  button: ProfileButton, signal: AbortSignal) => Promise<boolean>) | undefined>(undefined);
type ChooseChatButton = Extract<InlineBotButton, { kind: "switchInlineChoose" }>;
type DestinationChat = Chat & { forum?: true };
export const InlineBotDestinations = createContext<{
  find: (chatId: string, messageId: string, button: ChooseChatButton, query: string) => Promise<DestinationChat[]>;
  validate: (chatId: string, messageId: string, button: ChooseChatButton, destination: string) => Promise<DestinationChat | null>;
  topics?: (chatId: string, messageId: string, button: ChooseChatButton, destination: string, query: string,
    cursor?: NonNullable<ForumTopicPage["next"]>) => Promise<{ topics: ForumTopicTarget[]; next: ForumTopicPage["next"] } | null>;
  validateTopic?: (chatId: string, messageId: string, button: ChooseChatButton, destination: string,
    topic: ForumTopicTarget) => Promise<ForumTopic | null>;
} | undefined>(undefined);

type WebAppButton = Extract<InlineBotButton, { kind: "webApp" }>;
export type InlineMiniAppActions = {
  launch: (chatId: string, messageId: string, button: WebAppButton) => Promise<{ url: string; session: string } | null>;
  close: CloseMiniAppSession;
};
export const InlineMiniApps = createContext<InlineMiniAppActions | undefined>(undefined);

function GameDialog({ url, close, chatId, messageId, forward }: {
  url: string; close: () => void; chatId: string; messageId: string; forward?: ForwardActions;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [review, setReview] = useState<number>();
  const [scoreNotice, setScoreNotice] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    function gameEvent(event: MessageEvent) {
      const source = frame.current?.contentWindow;
      if (!dialog.current?.open || !source || event.source !== source || event.origin !== "null"
        || document.activeElement !== frame.current || !navigator.userActivation?.isActive
        || typeof event.data !== "string" || event.data.length > 512) return;
      const request = miniAppFrameEvent(event.data);
      if (request?.type === "share_game" && forward) {
        setScoreNotice(false);
        setReview((previous) => (previous ?? 0) + 1);
      } else if (request?.type === "share_score") setScoreNotice(true);
    }
    window.addEventListener("message", gameEvent);
    return () => window.removeEventListener("message", gameEvent);
  }, [forward]);
  const host = new URL(url).hostname;
  return <dialog ref={dialog} className="mtg-mini-app" aria-label={tr("Telegram game")} onClose={(event) => { event.stopPropagation(); close(); }}>
    <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close game")}</button>
    {forward && <MessageForward chatId={chatId} messageId={messageId} actions={forward} game reviewRequest={review} />}
    {scoreNotice && <p role="status">{tr("Sharing a score is unavailable in BB.")}</p>}
    <div className="mtg-mini-app-frame">
      <iframe ref={frame} title={tr("Game from {0}", [host])} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'" />
    </div>
    <a href={url} target="_blank" rel="noopener noreferrer">{tr("Open game in browser")}</a>
  </dialog>;
}

export function InlineBotKeyboard({ chatId, messageId, rows, gameForward }: {
  chatId: string;
  messageId: string;
  rows: InlineBotButton[][];
  gameForward?: ForwardActions;
}) {
  const { t: tr } = useTelegramLocale();
  const useInlineBot = useContext(UseInlineBotDraft);
  const useOtherChat = useContext(UseInlineBotInOtherChat);
  const destinations = useContext(InlineBotDestinations);
  const press = useContext(PressInlineBotButton);
  const openProfile = useContext(OpenInlineBotProfile);
  const followTelegramLink = useContext(OpenTelegramMessageLink);
  const miniApps = useContext(InlineMiniApps);
  const miniApp = useMiniAppLauncher();
  const inFlight = useRef(false);
  const navigationRequest = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [answer, setAnswer] = useState<BotButtonAnswer>();
  const [gameOpen, setGameOpen] = useState(false);
  const [chatPicker, setChatPicker] = useState<ChooseChatButton>();
  useEffect(() => () => navigationRequest.current?.abort(), []);

  async function invoke(button: CallbackButton) {
    if (!press || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAnswer(undefined);
    setGameOpen(false);
    try {
      setAnswer(await press(chatId, messageId, button));
    } catch {
      setAnswer({ state: "unknown" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice("Bot text copied.");
    } catch {
      setCopyNotice("Could not copy the bot text.");
    }
  }

  async function navigate(action: (signal: AbortSignal) => Promise<boolean>, unavailableText: string) {
    if (inFlight.current) return;
    const controller = new AbortController();
    navigationRequest.current = controller;
    inFlight.current = true;
    setBusy(true);
    setNavigationNotice("");
    const opened = await action(controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    navigationRequest.current = undefined;
    inFlight.current = false;
    setBusy(false);
    if (!opened) setNavigationNotice(unavailableText);
  }

  function openBotLink(value: string) {
    const target = botButtonLink(value);
    if (inFlight.current || !target || !window.confirm(tr("Open this link from the bot?\n\n{0}", [target.href]))) return;
    setNavigationNotice("");
    if (target.internal && followTelegramLink) {
      void navigate((signal) => followTelegramLink(target.href, signal), "Telegram link unavailable.");
    } else window.open(target.href, "_blank", "noopener,noreferrer");
  }

  function renderButton(button: InlineBotButton, column: number) {
    const props = { type: "button" as const, className: "mtg-action", "data-button-style": button.style,
      children: <><DecorativeCustomEmoji id={button.iconCustomEmojiId} className="mtg-bot-button-icon" />{button.label}</> };
    switch (button.kind) {
      case "url": return <button key={column} {...props} disabled={busy} onClick={() => openBotLink(button.url)} />;
      case "switchInline": return <button key={column} {...props} disabled={!useInlineBot || busy}
        onClick={() => useInlineBot?.(chatId, button.bot, button.query)} />;
      case "switchInlineChoose": return <button key={column} {...props} disabled={!destinations || !useOtherChat || busy}
        aria-haspopup="dialog" onClick={() => setChatPicker(button)} />;
      case "copy": return <button key={column} {...props} onClick={() => void copy(button.text)} />;
      case "profile": return <button key={column} {...props} disabled={!openProfile || busy}
        title={tr("Open Telegram profile")} onClick={() => {
          if (openProfile) void navigate((signal) => openProfile(chatId, messageId, button, signal), "Telegram profile unavailable.");
        }} />;
      case "webApp": return <button key={column} {...props} disabled={!miniApps || busy} onClick={() => {
        if (miniApps) miniApp.open({ target: { label: button.label }, launch: () => miniApps.launch(chatId, messageId, button),
          closeSession: miniApps.close });
      }} />;
      case "disabled": return <button key={column} {...props} disabled />;
      case "callback": return <button key={column} {...props} disabled={!press || busy}
        onClick={() => void invoke(button)} />;
    }
  }

  const feedback = !answer ? "" : answer.state === "answered" ? answer.text
    : answer.state === "changed" ? "This bot button changed. Wait for the updated message."
    : answer.state === "unavailable" ? "Telegram could not run this bot action."
    : "Telegram did not confirm the bot action.";
  const gameUrl = answer?.state === "answered" && answer.gameUrl ? miniAppFrameUrl(answer.gameUrl) : undefined;

  return <div className="mtg-inline-bot-keyboard" role="group" aria-label={tr("Bot buttons")} aria-busy={busy}>
    {rows.map((row, index) => <div key={index} className="mtg-inline-bot-row">
      {row.map(renderButton)}
    </div>)}
    {miniApp.dialog}
    {chatPicker && destinations && useOtherChat && <TelegramChatPickerDialog
      title={tr("Choose a chat for the bot query")} unavailableText={tr("Could not put this bot query in the selected chat.")}
      close={() => setChatPicker(undefined)} find={(query) => destinations.find(chatId, messageId, chatPicker, query)}
      findTopics={destinations.topics && destinations.validateTopic ? (chat, query, cursor) =>
        destinations.topics!(chatId, messageId, chatPicker, chat.id, query, cursor) : undefined}
      prepare={async (chat, signal, topic) => {
        const target = await destinations.validate(chatId, messageId, chatPicker, chat.id);
        if (signal.aborted || target?.id !== chat.id || !!target.forum !== !!topic) return false;
        if (!topic) return useOtherChat(target, chatPicker.bot, chatPicker.query);
        const current = await destinations.validateTopic?.(chatId, messageId, chatPicker, chat.id, topic);
        return !signal.aborted && !!current && current.id === topic.id && current.name === topic.name && !current.closed
          && useOtherChat(target, chatPicker.bot, chatPicker.query, current);
      }} />}
    {copyNotice && <p role="status">{tr(copyNotice)}</p>}
    {navigationNotice && <p role="status">{tr(navigationNotice)}</p>}
    {feedback && <p role={answer?.state === "answered" && answer.alert ? "alert" : "status"}>{tr(feedback)}</p>}
    {answer?.state === "answered" && answer.url &&
      <button type="button" className="mtg-action" disabled={busy} onClick={() => openBotLink(answer.url!)}>{tr("Open bot link")}</button>}
    {gameUrl && <button type="button" className="mtg-action" aria-haspopup="dialog" onClick={() => setGameOpen(true)}>{tr("Play game from ")}<bdi>{new URL(gameUrl).hostname}</bdi>
    </button>}
    {gameOpen && gameUrl && <GameDialog url={gameUrl} close={() => setGameOpen(false)}
      chatId={chatId} messageId={messageId} forward={gameForward} />}
  </div>;
}
