import { MiniAppConsole, miniAppConsoleEvents, type MiniAppConsoleEvent } from "./mini-app-console.tsx";
import { readMiniAppLaunchPreference, saveMiniAppLaunchPreference, type MiniAppLaunchPreference } from "./mini-app-launch-preferences.ts";
import { useTelegramLocale } from "./i18n/index.tsx";
import { miniAppMediaFrame, miniAppNoMediaPolicy, type MiniAppMediaAccess } from "../core/mini-app-media.ts";
import { MiniAppQrDialog } from "./mini-app-qr.tsx";
import { MiniAppDownloadReview } from "./mini-app-download.tsx";
import { formatSize } from "./format-size.ts";
import { formatPlaybackTime } from "./video-seek-preview.tsx";
import { formatStarBillingPeriod } from "./star-subscriptions.tsx";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Ellipsis, LayoutGrid, Maximize, Minimize, Minus, PanelRightClose, PanelRightOpen, Settings, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { MiniAppAgentPanel, type MiniAppAgentActions } from "./mini-app-agent-panel.tsx";
import { miniAppButton, miniAppButtonVisible, miniAppColor, miniAppContrastColor, miniAppInlineQuery, miniAppCustomRequest, miniAppDownloadRequest, miniAppHapticPattern, miniAppPopup, type MiniAppPopup, type MiniAppButton, miniAppFrameEvent, miniAppFrameUrl, miniAppLinkKey, miniAppNativeLink, miniAppReplyData, miniAppRequestId, miniAppRequestedLink, miniAppTheme as themeParams, type miniAppLinkReference } from "../core/mini-app.ts";

import { customEmojiId, miniAppAdministratorRightLabels, miniAppDeviceStorageOperation, miniAppPublicUsername, type AttachmentMiniApp, type ForumTopic, type ForumTopicTarget, type MiniAppChatType, type MiniAppDeviceStorageOperation, type MiniAppLaunchMode, type MiniAppLocationDecision, type PeerProfile, type TelegramPhoto, type UserPresence, type schemas } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { Button } from "../../components/ui/button.tsx";
import { InstantViewButton } from "./instant-view.tsx";
import { OpenTelegramMessageLink } from "./telegram-message-link.tsx";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import { isPlainKey } from "./composer-keys.ts";
import type { ManagedBotDraft } from "../core/contract.ts";
import { ManagedBotCreation } from "./managed-bot-creation.tsx";
import type { AttachmentMiniAppConsent, AttachmentMiniAppReview, InstalledMenuMiniApp } from "../core/contract.ts";

export type LaunchMiniApp = (url: string, consent?: AttachmentMiniAppConsent) => Promise<{ url: string; session?: string; mode?: MiniAppLaunchMode; requireSameOrigin?: true } | null>;
export type SendMiniAppData = (session: string, data: string) => Promise<"sent" | "changed" | "failed" | "unknown">;
export type CloseMiniAppSession = (session: string) => Promise<boolean>;
type MiniAppInvoice = { title: string; description: string; stars: number; confirmation: string; billingPeriodSeconds?: number };

export const MiniAppSessionActions = createContext<MiniAppAgentActions & {
  preferenceScope?: string;
  close: CloseMiniAppSession;
  subscribeToClosures?: (listener: (session: string) => void) => () => void;
  writeAccess: (session: string, confirm: boolean) => Promise<"allowed" | "prompt" | "unavailable">;
  previewPhone?: (session: string) => Promise<{ bot: string; confirmation: string } | null>;
  previewInvoice?: (session: string, slug: string) => Promise<MiniAppInvoice | null>;
  payInvoice?: (session: string, confirmation: string) => Promise<"paid" | "failed" | "pending">;
  sharePhone?: (session: string, confirmation: string) => Promise<"sent" | "failed" | "unknown">;
  previewEmojiAccess?: (session: string) => Promise<{ kind: "allowed" } | { kind: "review"; confirmation: string; bot: string } | null>;
  confirmEmojiAccess?: (session: string, confirmation: string) => Promise<boolean>;
  previewEmojiStatus?: (session: string, emoji: string | null, duration: number) => Promise<
    { kind: "review"; confirmation: string; label: string } |
    { kind: "failed"; error: "UNSUPPORTED" | "SUGGESTED_EMOJI_INVALID" | "DURATION_INVALID" | "SERVER_ERROR" }>;
  confirmEmojiStatus?: (session: string, confirmation: string) => Promise<boolean>;
  locationAccess?: MiniAppLocationAccess;
  secureStorage?: (session: string, operation: MiniAppDeviceStorageOperation) => Promise<ReturnType<typeof schemas.miniAppSecureStorage.output.parse>>;
  deviceStorage?: (session: string, operation: MiniAppDeviceStorageOperation) => Promise<ReturnType<typeof schemas.miniAppDeviceStorage.output.parse>>;
  clipboardAccess?: (session: string) => Promise<{ bot: string } | null>;
  checkDownload?: (session: string, url: string, fileName: string) => Promise<{ bot: string } | null>;
  previewPreparedMessage?: (session: string, id: string) => Promise<PreparedPreviewResult>;
  preparedThumbnail?: (session: string, confirmation: string) => Promise<TelegramPhoto | null>;
  preparedChats?: (session: string, confirmation: string, query: string) => Promise<MiniAppDestinationChat[]>;
  preparedTopics?: (session: string, confirmation: string, id: string, query: string, cursor?: PreparedTopicCursor) => Promise<PreparedTopicPage | null>;
  sendPreparedMessage?: (session: string, confirmation: string, id: string, expectedName: string, topic?: ForumTopicTarget) => Promise<"sent" | "failed" | "unknown">;
  inlineChats?: (session: string, types: MiniAppChatType[], query: string) => Promise<MiniAppDestinationChat[]>;
  inlineTopics?: (session: string, types: MiniAppChatType[], id: string, query: string, cursor?: PreparedTopicCursor) =>
    Promise<PreparedTopicPage | null>;
  inlineDestination?: (session: string, types: MiniAppChatType[], id: string, topic?: ForumTopicTarget) =>
    Promise<{ chat: Chat; topic?: ForumTopic } | null>;
  previewChatRequest?: (session: string, requestId: string) => Promise<ChatRequestResult>;
  findRequestedChats?: (session: string, confirmation: string, query: string) => Promise<RequestedChat[]>;
  shareRequestedChats?: (session: string, confirmation: string, selected: Pick<RequestedChat, "id" | "name">[]) => Promise<"sent" | "failed" | "unknown">;
  createRequestedChat?: (session: string, confirmation: string, title: string, username?: string) =>
    Promise<ReturnType<typeof schemas.createMiniAppRequestedChat.output.parse>>;
  createManagedBot?: (session: string, confirmation: string, draft: ManagedBotDraft) => Promise<ReturnType<typeof schemas.createMiniAppManagedBot.output.parse>>;
  invokeCustomMethod?: (session: string, method: string, parameters: string) => Promise<ReturnType<typeof schemas.invokeMiniAppCustomMethod.output.parse>>;
} | undefined>(undefined);
type PreparedPreviewResult = ReturnType<typeof schemas.previewMiniAppPreparedMessage.output.parse>;
type PreparedPreview = Extract<PreparedPreviewResult, { confirmation: string }>;
type ChatRequestResult = ReturnType<typeof schemas.previewMiniAppChatRequest.output.parse>;
type RequestedChat = ReturnType<typeof schemas.findMiniAppRequestedChats.output.parse>[number];
type ChatRequestReview = Extract<ChatRequestResult, { confirmation: string }> & { requestId: string; createdSpace?: true };
type MiniAppLocationAccess = (session: string, decision?: MiniAppLocationDecision) => Promise<{ bot: string; decision: MiniAppLocationDecision } | null>;
type MiniAppTarget = NonNullable<ReturnType<typeof miniAppLinkReference>> | { label: string };

// The iframe is laid out inside the dialog, below the header and above the controls in every mode.
const frameInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const windowColors = { bg_color: themeParams.bg_color, secondary_bg_color: themeParams.secondary_bg_color };
const bottomBarColors = { ...windowColors, bottom_bar_bg_color: themeParams.bottom_bar_bg_color };

function MiniAppPopupDialog({ popup, finish }: { popup: MiniAppPopup; finish: (buttonId?: string) => void }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return <dialog ref={dialog} className="mtg-mini-app-popup" aria-label={popup.title || tr("Mini App dialog")}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); finish(); }}>
    {popup.title && <strong><bdi>{popup.title}</bdi></strong>}
    <p><bdi>{popup.message}</bdi></p>
    <div className="mtg-mini-app-popup-buttons" data-stacked={popup.buttons.length === 3 || undefined}>
      {popup.buttons.map((button, index) => <button key={index} type="button" className="mtg-action"
        data-destructive={button.destructive} onClick={() => finish(button.id)}><bdi>{button.text}</bdi></button>)}
    </div>
  </dialog>;
}

function ClipboardReview({ bot, finish }: { bot: string; finish: (text?: string) => void }) {
  const { t: tr } = useTelegramLocale();
  const [text, setText] = useState<string>();
  const [tooLong, setTooLong] = useState(false);
  return <section aria-label={tr("Mini App clipboard request")}>
    <p>{tr("Paste the text you want to share with ")}<bdi>{bot}</bdi>.</p>
    <textarea aria-label={tr("Clipboard text to share")} readOnly value={text ?? ""} onPaste={(event) => {
      event.preventDefault();
      const value = event.clipboardData.getData("text/plain");
      setTooLong(value.length > 131072);
      setText(value && value.length <= 131072 ? value : undefined);
    }} />
    {tooLong && <p role="alert">{tr("The pasted text is too long.")}</p>}
    <button type="button" className="mtg-action" disabled={text === undefined} onClick={() => finish(text)}>{tr("Share pasted text")}</button>
    <button type="button" className="mtg-action" onClick={() => finish()}>{tr("Cancel clipboard request")}</button>
  </section>;
}

type MiniAppDestinationChat = Chat & { forum?: true };
type PreparedTopicPage = NonNullable<ReturnType<typeof schemas.miniAppPreparedTopics.output.parse>>;
type PreparedTopicCursor = NonNullable<PreparedTopicPage["next"]>;
type FindInlineChats = (query: string) => Promise<MiniAppDestinationChat[]>;

function InlineChatPicker<T extends RequestedChat>({ find, choose, disabled, selected }: {
  find: (query: string) => Promise<T[]>; choose: (chat: T) => void; disabled?: boolean; selected?: readonly RequestedChat[];
}) {
  const { t: tr } = useTelegramLocale();
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<T[]>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (busy || disabled) return;
    setBusy(true);
    setError(false);
    setChats(undefined);
    try { setChats(await find(query.trim())); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  return <div>
    <input aria-label={tr("Find eligible Telegram chats")} value={query} maxLength={128} disabled={disabled} onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        void search();
      }} />
    <button type="button" className="mtg-action" disabled={busy || disabled} onClick={() => void search()}>
      {query.trim() ? tr("Find chats") : tr("Show recent chats")}
    </button>
    {busy && <p role="status">{tr("Finding eligible chats…")}</p>}
    {error && <p role="alert">{tr("Could not find eligible Telegram chats.")}</p>}
    {chats?.length === 0 && <p role="status">{tr("No eligible chats found.")}</p>}
    {!!chats?.length && <ul aria-label={tr("Eligible Telegram chats")}>
      {chats.map((chat) => <li key={chat.id}><button type="button" className="mtg-action" disabled={disabled}
        aria-pressed={selected?.some(({ id }) => id === chat.id)} onClick={() => choose(chat)}>
        <bdi>{chat.name}</bdi> <small>{chat.subtitle}</small>
      </button></li>)}
    </ul>}
  </div>;
}

function NewRequestedChat({ kind, busy, requiresUsername, createdSpace, create }: {
  kind: "group" | "forum" | "channel";
  busy: boolean;
  requiresUsername?: true;
  createdSpace?: true;
  create: (title: string, username?: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const name = title.trim();
  const handle = username.trim().replace(/^@/, "");
  const valid = !!name && name.length <= 128 && !/[\p{Cc}]/u.test(name)
    && (!requiresUsername || miniAppPublicUsername.safeParse(handle).success);
  return <details>
    <summary>{tr("Create a ")}{requiresUsername ? tr("public") : tr("private")} {kind}</summary>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid && !busy) create(name, requiresUsername ? handle : undefined);
    }}>
      <label>{tr("New ")}{kind}{tr(" name ")}<input value={title} maxLength={128} disabled={busy} readOnly={createdSpace}
        onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      {requiresUsername && <>
        <label>{tr("Public username ")}<input value={username} maxLength={33} disabled={busy}
          onChange={(event) => setUsername(event.currentTarget.value)} /></label>
        <p>{tr("Anyone can find this ")}{kind}{tr(" by its public username.")}</p>
      </>}
      <p>{tr("You can review sharing after creation.")}</p>
      <button type="submit" className="mtg-action" disabled={!valid || busy}>{createdSpace ? tr("Set public username") : tr("Create {0}", [kind])}</button>
    </form>
  </details>;
}

function PreparedTopicPicker({ find, choose }: {
  find: (query: string, cursor?: PreparedTopicCursor) => Promise<PreparedTopicPage | null>;
  choose: (topic: ForumTopicTarget) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [page, setPage] = useState<PreparedTopicPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function search(cursor?: PreparedTopicCursor) {
    if (busy) return;
    const term = cursor ? searched : query.trim();
    setBusy(true);
    setError(false);
    if (!cursor) { setSearched(term); setPage(undefined); }
    try {
      const result = await find(term, cursor);
      if (!result) { setError(true); return; }
      setPage((previous) => cursor && previous ? { ...result,
        topics: [...new Map([...previous.topics, ...result.topics].map((topic) => [topic.id, topic])).values()],
      } : result);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div>
    <input aria-label={tr("Find forum topics")} value={query} maxLength={128} onChange={(event) => setQuery(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void search();
      }} />
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void search()}>
      {query.trim() ? tr("Find topics") : tr("Show topics")}
    </button>
    {busy && <p role="status">{tr("Finding forum topics…")}</p>}
    {error && <p role="alert">{tr("Could not load forum topics.")}</p>}
    {page?.topics.length === 0 && <p>{tr("No open topics on this page.")}</p>}
    {!!page?.topics.length && <ul aria-label={tr("Forum topics")}>{page.topics.map((topic) => <li key={topic.id}>
      <button type="button" className="mtg-action" onClick={() => choose(topic)}><bdi>{topic.name}</bdi></button>
    </li>)}</ul>}
    {page?.next && <button type="button" className="mtg-action" disabled={busy} onClick={() => void search(page.next!)}>{tr("More topics")}</button>}
  </div>;
}

type MiniAppDialogProps = {
  target: MiniAppTarget; launch: LaunchMiniApp; close: () => void; closeSession?: CloseMiniAppSession; sendData?: SendMiniAppData;
  handoffUrl?: string;
  attachmentDestination?: { chat: string; topic?: string };
  attachmentReview?: AttachmentMiniAppReview;
  resumeRequest?: number;
  onMinimizedChange?: (minimized: boolean) => void;
  useCurrentChatQuery?: (query: string) => boolean;
  useOtherChatQuery?: (chat: Chat, query: string, topic?: ForumTopic) => boolean;
  checkAgeVerification?: () => Promise<boolean>;
  entryPoint?: readonly ["bot-menu", chatId: string, revision: string]
    | readonly ["bot-profile", chatId: string]
    | readonly ["age-verification", botUsername: string]
    | readonly ["side-menu", botId: number];
};
export type MiniAppLaunch = Omit<MiniAppDialogProps, "close" | "resumeRequest" | "onMinimizedChange"> & {
  onClosed?: () => void;

};
export const OpenMiniApp = createContext<((launch: MiniAppLaunch) => void) | undefined>(undefined);

type MiniAppWindow = { id: number; launch: MiniAppLaunch; key?: string; resumeRequest?: number; minimized?: boolean };

function miniAppLabel(target: MiniAppTarget) {
  return "label" in target ? target.label : target.app ? `${target.app} · @${target.bot}` : `@${target.bot}`;
}

function MinimizedMiniApps({ windows, resume }: { windows: MiniAppWindow[]; resume: (id: number) => void }) {
  const { t: tr } = useTelegramLocale();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const apps = windows.map(({ id, launch }) => ({ id, label: miniAppLabel(launch.target) }));
  if (!apps.length) return null;
  if (apps.length === 1) {
    const { id, label } = apps[0]!;
    return <button type="button" className="mtg-action mtg-mini-app-resume" onClick={() => resume(id)}>{tr("Resume Mini App ")}<bdi>{label}</bdi>
    </button>;
  }

  return <div className="mtg-mini-app-switcher" onKeyDown={(event) => {
    if (!expanded || !isPlainKey(event, "Escape")) return;
    event.preventDefault();
    setExpanded(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" className="mtg-action" aria-expanded={expanded}
      aria-controls={panelId} onClick={() => setExpanded(!expanded)}>{tr("Minimized Mini Apps (")}{apps.length})</button>
    <ul id={panelId} aria-label={tr("Minimized Mini Apps")} hidden={!expanded}>
      {apps.map(({ id, label }, index) => <li key={id}>
        <button type="button" className="mtg-action mtg-mini-app-resume" onClick={() => { setExpanded(false); resume(id); }}>{tr("Resume Mini App ")}<bdi>{label}</bdi>{apps.some((app) => app.id !== id && app.label === label) && tr(" · Window {0}", [index + 1])}
        </button>
      </li>)}
    </ul>
  </div>;
}

export function useMiniAppWindows() {
  const nextId = useRef(0);
  const [entries, setEntries] = useState<MiniAppWindow[]>([]);
  const open = useCallback((launch: MiniAppLaunch) => {
    const id = ++nextId.current;
    const linkKey = "url" in launch.target ? miniAppLinkKey(launch.target.url) : undefined;
    const key = linkKey ? `link:${linkKey}` : launch.entryPoint && JSON.stringify(launch.entryPoint);
    setEntries((previous) => {
      const existing = key && previous.find((entry) => entry.key === key);
      if (existing) return previous.map((entry) => entry === existing ? { ...entry, resumeRequest: id } : entry);
      return [...previous, { id, launch, key }];
    });
  }, []);
  const resume = (id: number) => {
    const resumeRequest = ++nextId.current;
    setEntries((previous) => previous.map((entry) => entry.id === id ? { ...entry, resumeRequest } : entry));
  };

  return { open, dialog: entries.length > 0 && <div className="mtg-mini-app-host">
    {entries.map(({ id, launch, resumeRequest }) => <MiniAppDialog key={id} {...launch} resumeRequest={resumeRequest}
      onMinimizedChange={(minimized) => setEntries((previous) => previous.map((entry) => entry.id === id ? { ...entry, minimized } : entry))}
      close={() => {
        setEntries((previous) => previous.filter((entry) => entry.id !== id));
        launch.onClosed?.();
      }} />)}
    {entries.some(({ minimized }) => minimized) && <div className="mtg-mini-app-minimized">
      <MinimizedMiniApps windows={entries.filter(({ minimized }) => minimized)} resume={resume} />
    </div>}
  </div> };
}

export function useMiniAppLauncher() {
  const open = useContext(OpenMiniApp);
  const local = useMiniAppWindows();
  return open ? { open, dialog: undefined } : local;
}

export function MiniAppDialog({ target, launch, close, closeSession, sendData, handoffUrl, useCurrentChatQuery, useOtherChatQuery, attachmentDestination, attachmentReview, resumeRequest, onMinimizedChange, checkAgeVerification, entryPoint }: MiniAppDialogProps) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [allowWriteAccess, setAllowWriteAccess] = useState(false);
  const [mediaAccess, setMediaAccess] = useState<MiniAppMediaAccess>({ camera: false, microphone: false });
  const [mediaFrame, setMediaFrame] = useState<ReturnType<typeof miniAppMediaFrame>>();
  const canRequestMedia = window.isSecureContext && "credentialless" in HTMLIFrameElement.prototype;
  const attachmentReady = (!attachmentReview?.requireTerms || acceptedTerms) && (!attachmentReview?.requestWriteAccess || allowWriteAccess);
  const active = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const sessionActions = useContext(MiniAppSessionActions);
  const identity = entryPoint?.[0] === "bot-profile" || entryPoint?.[0] === "bot-menu" ? entryPoint
    : "url" in target ? ["link", target.bot, target.app ?? ""] : undefined;
  const preferenceKey = sessionActions?.preferenceScope && identity && !attachmentReview && !checkAgeVerification
    ? `makosh.telegram.miniApp.${sessionActions.preferenceScope}.${JSON.stringify(identity)}` : undefined;
  const [autoPending, setAutoPending] = useState(() => !!preferenceKey && !!readMiniAppLaunchPreference(preferenceKey));
  const autoAttempt = useRef<string | undefined>(undefined);
  const requiresOrigin = useRef(false);
  const [deviceDraft, setDeviceDraft] = useState<MiniAppMediaAccess>();
  const pendingDeviceChange = useRef<MiniAppMediaAccess | undefined>(undefined);
  const [split, setSplit] = useState(false);
  const [splitNotice, setSplitNotice] = useState(false);
  const changingPresentation = useRef(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const consoleEvents = useRef<MiniAppConsoleEvent[]>([]);
  const consoleSequence = useRef(0);
  const readConsole = useCallback(() => consoleEvents.current, []);
  const clearConsole = useCallback(() => { consoleEvents.current = []; }, []);

  function recordConsole(direction: MiniAppConsoleEvent["direction"], name: string) {
    if (direction !== "frame" && !miniAppConsoleEvents.has(name)) return;
    consoleEvents.current = [{ id: ++consoleSequence.current, at: Date.now(), direction, name }, ...consoleEvents.current.slice(0, 79)];
  }

  const [agentPanel, setAgentPanel] = useState(false);
  const loadEmoji = useContext(CustomEmojiLoader);
  const endSession = closeSession ?? sessionActions?.close;
  const checkingWriteAccess = useRef(false);
  const checkingPhone = useRef(false);
  const checkingDownload = useRef(false);
  const [downloadNotice, setDownloadNotice] = useState("");
  const handlingEmojiAccess = useRef(false);
  const applyingEmojiAccess = useRef(false);
  const [emojiAccessReview, setEmojiAccessReview] = useState<{ bot: string; confirmation: string }>();
  const [emojiAccessBusy, setEmojiAccessBusy] = useState(false);
  const handlingEmojiStatus = useRef(false);
  const applyingEmojiStatus = useRef(false);
  const [emojiStatusReview, setEmojiStatusReview] = useState<{ emoji: string | null; duration: number; confirmation: string; label: string }>();
  const [emojiStatusBusy, setEmojiStatusBusy] = useState(false);
  const clipboardRequest = useRef<{ id: string; token: string } | undefined>(undefined);
  const [clipboardReview, setClipboardReview] = useState<{ bot: string }>();
  const handlingPrepared = useRef(false);
  const sendingPrepared = useRef(false);
  const [prepared, setPrepared] = useState<PreparedPreview>();
  const [preparedThumbnail, setPreparedThumbnail] = useState<string>();
  const [preparedChat, setPreparedChat] = useState<MiniAppDestinationChat>();
  const [preparedTopic, setPreparedTopic] = useState<ForumTopicTarget>();
  const [preparedBusy, setPreparedBusy] = useState(false);
  const [preparedError, setPreparedError] = useState("");
  const handlingChatRequest = useRef(false);
  const sendingChatRequest = useRef(false);
  const [chatRequest, setChatRequest] = useState<ChatRequestReview>();
  const [requestedChats, setRequestedChats] = useState<RequestedChat[]>([]);
  const [chatRequestBusy, setChatRequestBusy] = useState(false);
  const [chatRequestStatus, setChatRequestStatus] = useState("");
  const handlingLocation = useRef(false);
  const choosingLocation = useRef(false);
  const [locationReview, setLocationReview] = useState<{ bot: string; settings: boolean }>();
  const [locationBusy, setLocationBusy] = useState(false);
  const customRequests = useRef(new Set<string>());
  const storageRequests = useRef(new Set<string>());
  const biometryReported = useRef(false);
  const [download, setDownload] = useState<{ url: string; fileName: string; bot: string }>();
  const [phoneReview, setPhoneReview] = useState<{ bot: string; confirmation: string }>();
  const [phoneSending, setPhoneSending] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState("");
  const invoiceRequest = useRef<string | undefined>(undefined);
  const [invoice, setInvoice] = useState<{ slug: string; details: MiniAppInvoice }>();
  const payingInvoice = useRef(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceStatus, setInvoiceStatus] = useState("");
  const [writePermission, setWritePermission] = useState<"prompt" | "working">();
  const [source, setSource] = useState<string>();
  const [frameRevision, setFrameRevision] = useState(0);
  const frameGeneration = useRef(0);
  const ageHintSeen = useRef(false);
  const ageCheckInFlight = useRef(false);
  const [ageStatus, setAgeStatus] = useState<"checking" | "unconfirmed" | "failed">();
  const [frameLoading, setFrameLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [inlineQuery, setInlineQuery] = useState<ReturnType<typeof miniAppInlineQuery>>();
  const [inlineForum, setInlineForum] = useState<MiniAppDestinationChat>();
  const [inlineDestinationPending, setInlineDestinationPending] = useState(false);
  const [inlineDestinationFailed, setInlineDestinationFailed] = useState(false);
  const inlineDestinationRequest = useRef(false);
  const [reply, setReply] = useState<string>();
  const [replyStatus, setReplyStatus] = useState("");
  const [returning, setReturning] = useState(false);
  const followTelegram = useContext(OpenTelegramMessageLink);
  const linkRequest = useRef<AbortController | undefined>(undefined);
  const [link, setLink] = useState<ReturnType<typeof miniAppRequestedLink>>();
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const minimizedRef = useRef(false);
  const visible = useRef(!document.hidden);
  const [warnOnClose, setWarnOnClose] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloadStatus, setReloadStatus] = useState("");
  const [back, setBack] = useState(false);
  const [settings, setSettings] = useState(false);
  const [headerColor, setHeaderColor] = useState<string>();
  const [backgroundColor, setBackgroundColor] = useState<string>();
  const [bottomBarColor, setBottomBarColor] = useState<string>();
  const [primary, setPrimary] = useState<MiniAppButton>();
  const [secondary, setSecondary] = useState<MiniAppButton>();

  const [qrLabel, setQrLabel] = useState<string>();
  const [popup, setPopup] = useState<MiniAppPopup>();
  const popupOpen = useRef(false);
  const popupTimes = useRef<number[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [fullscreenRequested, setFullscreenRequested] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenState = useRef(false);
  const fullscreenEntry = useRef<{ cancelled: boolean } | undefined>(undefined);
  const orientationLock = useRef<{ orientation: ScreenOrientation; element: HTMLElement } | undefined>(undefined);
  const lastHaptic = useRef(-Infinity);

  const releaseOrientationLock = useCallback(() => {
    const request = orientationLock.current;
    orientationLock.current = undefined;
    if (request && document.fullscreenElement === request.element) {
      try { request.orientation.unlock(); } catch { /* The browser may have exited fullscreen. */ }
    }
  }, []);

  function lockOrientation(payload: unknown) {
    if (!payload || typeof payload !== "object" || !("locked" in payload) || typeof payload.locked !== "boolean") return;
    if (!payload.locked) { releaseOrientationLock(); return; }
    const element = surface.current;
    if (!element || document.fullscreenElement !== element || orientationLock.current) return;
    const orientation = window.screen.orientation as (ScreenOrientation & { lock?: (type: OrientationType) => Promise<void> }) | undefined;
    if (!orientation?.lock || typeof orientation.unlock !== "function") return;
    const request = { orientation, element };
    orientationLock.current = request;
    void orientation.lock(orientation.type).catch(() => {
      if (orientationLock.current === request) orientationLock.current = undefined;
    });
  }

  function post(eventType: string, eventData: object | null = {}) {
    if (frameRevision !== frameGeneration.current) return;
    const content = frame.current?.contentWindow;
    if (!content) return;
    content.postMessage(JSON.stringify({ eventType, eventData }), mediaFrame?.origin ?? "*");
    recordConsole("bb", eventType);
  }
  const appLabel = miniAppLabel(target);

  function updateVisibility() {
    const current = !document.hidden && !minimizedRef.current;
    if (current === visible.current) return;
    visible.current = current;
    if (!current) releaseOrientationLock();
    post("visibility_changed", { is_visible: current });
  }

  function setWindowMinimized(value: boolean) {
    const element = dialog.current;
    if (!element || minimizedRef.current === value) return;
    minimizedRef.current = value;
    if (value) element.close();
    else {
      const dockOccupied = split && !!element.closest(".mtg")?.querySelector('.mtg-mini-app[data-presentation="split"][open]');
      if (split && !dockOccupied) element.show();
      else {
        if (dockOccupied) setSplit(false);
        element.showModal();
      }
    }
    setMinimized(value);
    onMinimizedChange?.(value);
    updateVisibility();
  }
  function changePresentation() {
    const element = dialog.current;
    if (!element?.open) return;
    if (!split && element.closest(".mtg")?.querySelector('.mtg-mini-app[data-presentation="split"][open]')) {
      setSplitNotice(true);
      return;
    }
    setSplitNotice(false);
    changingPresentation.current = true;
    try {
      element.close();
      if (split) element.showModal();
      else element.show();
      setSplit(!split);
    } finally {
      changingPresentation.current = false;
    }
  }

  useLayoutEffect(() => {
    if (resumeRequest !== undefined) setWindowMinimized(false);
  }, [resumeRequest]);

  function reportUnavailableBiometry() {
    biometryReported.current = true;
    post("biometry_info_received", {
      available: false, access_requested: false, access_granted: false, token_saved: false, device_id: "",
    });
  }
  function finishEmojiAccess(allowed: boolean) {
    handlingEmojiAccess.current = false;
    applyingEmojiAccess.current = false;
    setEmojiAccessReview(undefined);
    setEmojiAccessBusy(false);
    post("emoji_status_access_requested", { status: allowed ? "allowed" : "cancelled" });
  }

  async function reviewEmojiAccess() {
    if (handlingEmojiAccess.current) return;
    if (!navigator.userActivation?.isActive) {
      finishEmojiAccess(false);
      return;
    }
    const token = session.current;
    const preview = sessionActions?.previewEmojiAccess;
    if (!token || !preview || !sessionActions.confirmEmojiAccess) {
      finishEmojiAccess(false);
      return;
    }
    handlingEmojiAccess.current = true;
    const result = await preview(token).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (result?.kind === "review") setEmojiAccessReview(result);
    else finishEmojiAccess(result?.kind === "allowed");
  }

  async function applyEmojiAccess() {
    const token = session.current;
    const confirm = sessionActions?.confirmEmojiAccess;
    if (!token || !confirm || !emojiAccessReview || applyingEmojiAccess.current) return;
    applyingEmojiAccess.current = true;
    setEmojiAccessBusy(true);
    const result = await confirm(token, emojiAccessReview.confirmation).catch(() => false);
    if (active.current && session.current === token) finishEmojiAccess(result);
  }

  async function reviewEmojiStatus(payload: unknown) {
    if (handlingEmojiStatus.current) return;
    if (!navigator.userActivation?.isActive) {
      post("emoji_status_failed", { error: "USER_DECLINED" });
      return;
    }
    const token = session.current;
    const preview = sessionActions?.previewEmojiStatus;
    if (!token || !preview || !sessionActions.confirmEmojiStatus) {
      post("emoji_status_failed", { error: "UNSUPPORTED" });
      return;
    }
    const value = payload && typeof payload === "object" && "custom_emoji_id" in payload ? payload.custom_emoji_id : undefined;
    const emoji = value === "0" ? null : customEmojiId.safeParse(value).data;
    if (emoji === undefined) {
      post("emoji_status_failed", { error: "SUGGESTED_EMOJI_INVALID" });
      return;
    }
    const duration = payload && typeof payload === "object" && "duration" in payload ? payload.duration : 0;
    if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 || duration > 2147483647) {
      post("emoji_status_failed", { error: "DURATION_INVALID" });
      return;
    }
    handlingEmojiStatus.current = true;
    const result = await preview(token, emoji, duration).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (result?.kind === "review") setEmojiStatusReview({ emoji, duration, confirmation: result.confirmation, label: result.label });
    else {
      handlingEmojiStatus.current = false;
      post("emoji_status_failed", { error: result?.error ?? "SERVER_ERROR" });
    }
  }
  async function applyEmojiStatus() {
    const token = session.current;
    const confirm = sessionActions?.confirmEmojiStatus;
    if (!token || !confirm || !emojiStatusReview || applyingEmojiStatus.current) return;
    applyingEmojiStatus.current = true;
    setEmojiStatusBusy(true);
    const applied = await confirm(token, emojiStatusReview.confirmation).catch(() => false);
    if (!active.current || session.current !== token) return;
    handlingEmojiStatus.current = false;
    applyingEmojiStatus.current = false;
    setEmojiStatusReview(undefined);
    setEmojiStatusBusy(false);
    if (applied) post("emoji_status_set", null);
    else post("emoji_status_failed", { error: "SERVER_ERROR" });
  }

  function finishClipboard(text?: string) {
    const current = clipboardRequest.current;
    clipboardRequest.current = undefined;
    setClipboardReview(undefined);
    if (current && active.current && session.current === current.token) {
      post("clipboard_text_received", { req_id: current.id, ...(text !== undefined && { data: text }) });
    }
  }
  async function reviewClipboard(payload: unknown) {
    const id = miniAppRequestId(payload);
    if (!id || clipboardRequest.current?.id === id) return;
    const token = session.current;
    const check = sessionActions?.clipboardAccess;
    if (clipboardRequest.current || !token || !check || !navigator.userActivation?.isActive) {
      post("clipboard_text_received", { req_id: id });
      return;
    }
    const request = { id, token };
    clipboardRequest.current = request;
    const expires = Date.now() + 10000;
    const result = await check(token).catch(() => null);
    if (!active.current || session.current !== token || clipboardRequest.current !== request) return;
    if (result && Date.now() < expires) setClipboardReview(result);
    else finishClipboard();
  }

  function postLocationAccess(decision?: MiniAppLocationDecision) {
    post("location_checked", decision ? {
      available: true, access_requested: decision !== "ask", access_granted: decision === "allowed",
    } : { available: false });
  }

  function currentLocation(): Promise<object> {
    if (!navigator.geolocation) return Promise.resolve({ available: false });
    return new Promise<object>((resolve) => {
      const optional = (value: number | null) => typeof value === "number" && Number.isFinite(value) ? value : null;
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)
          || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180) {
          resolve({ available: false });
          return;
        }
        resolve({ available: true, latitude: coords.latitude, longitude: coords.longitude,
          altitude: optional(coords.altitude), course: optional(coords.heading), speed: optional(coords.speed),
          horizontal_accuracy: optional(coords.accuracy), vertical_accuracy: optional(coords.altitudeAccuracy),
          course_accuracy: null, speed_accuracy: null });
      }, () => resolve({ available: false }), { timeout: 10000, maximumAge: 0 });
    }).catch(() => ({ available: false }));
  }

  async function authorizedLocation(token: string, access: MiniAppLocationAccess) {
    const location = await currentLocation();
    if (!active.current || session.current !== token) return { available: false };
    const permission = await access(token).catch(() => null);
    return permission?.decision === "allowed" ? location : { available: false };
  }

  async function handleLocation(kind: "check" | "request" | "settings") {
    if (kind === "settings" && !navigator.userActivation?.isActive) return;
    if (handlingLocation.current && kind !== "check") return;
    const token = session.current;
    const access = sessionActions?.locationAccess;
    if (!token || !access || !navigator.geolocation) {
      if (kind === "check") postLocationAccess();
      if (kind === "request") post("location_requested", { available: false });
      return;
    }
    if (kind !== "check") handlingLocation.current = true;
    const status = await access(token).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (kind === "check") { postLocationAccess(status?.decision); return; }
    if (status && (kind === "settings" || status.decision === "ask")) {
      setLocationReview({ bot: status.bot, settings: kind === "settings" });
      return;
    }
    const location = status?.decision === "allowed" ? await authorizedLocation(token, access) : { available: false };
    if (!active.current || session.current !== token) return;
    handlingLocation.current = false;
    if (kind === "request") post("location_requested", location);
  }

  async function chooseLocation(decision?: MiniAppLocationDecision) {
    const token = session.current;
    const access = sessionActions?.locationAccess;
    if (!token || !access || !locationReview || choosingLocation.current) return;
    choosingLocation.current = true;
    setLocationBusy(true);
    const status = decision ? await access(token, decision).catch(() => null) : null;
    if (!active.current || session.current !== token) return;
    if (locationReview.settings) {
      if (status) postLocationAccess(status.decision);
    } else {
      const location = status?.decision === "allowed" ? await authorizedLocation(token, access) : { available: false };
      if (!active.current || session.current !== token) return;
      post("location_requested", location);
    }
    choosingLocation.current = false;
    handlingLocation.current = false;
    setLocationReview(undefined);
    setLocationBusy(false);
  }

  async function deviceStorage(kind: MiniAppDeviceStorageOperation["kind"], payload: unknown) {
    const req_id = miniAppRequestId(payload);
    if (!req_id || storageRequests.current.has(req_id)) return;
    const token = session.current;
    const storage = sessionActions?.deviceStorage;
    const operation = miniAppDeviceStorageOperation.safeParse({ ...(payload as object), kind });
    if (!operation.success || !token || !storage || storageRequests.current.size >= 8) {
      post("device_storage_failed", { req_id, error: "UNKNOWN_ERROR" });
      return;
    }
    storageRequests.current.add(req_id);
    try {
      const result = await storage(token, operation.data).catch(() => ({ status: "failed" as const, error: "UNKNOWN_ERROR" }));
      if (!active.current || session.current !== token) return;
      if (result.status === "failed") post("device_storage_failed", { req_id, error: result.error });
      else if (kind === "get") post("device_storage_key_received", { req_id, value: result.value });
      else post(kind === "save" ? "device_storage_key_saved" : "device_storage_cleared", { req_id });
    } finally { storageRequests.current.delete(req_id); }
  }

  async function secureStorage(kind: MiniAppDeviceStorageOperation["kind"] | "restore", payload: unknown) {
    const req_id = miniAppRequestId(payload);
    if (!req_id || storageRequests.current.has(req_id)) return;
    const token = session.current;
    const storage = sessionActions?.secureStorage;
    const operation = miniAppDeviceStorageOperation.safeParse({ ...(payload as object), kind: kind === "restore" ? "get" : kind });
    if (!token || !storage) {
      post("secure_storage_failed", { req_id, error: "UNSUPPORTED" });
      return;
    }
    if (!operation.success || storageRequests.current.size >= 8) {
      post("secure_storage_failed", { req_id, error: "UNKNOWN_ERROR" });
      return;
    }
    storageRequests.current.add(req_id);
    try {
      const result = await storage(token, operation.data).catch(() => ({ status: "failed" as const, error: "UNKNOWN_ERROR" }));
      if (!active.current || session.current !== token) return;
      if (result.status === "failed") post("secure_storage_failed", { req_id, error: result.error });
      else if (kind === "get") post("secure_storage_key_received", { req_id, value: result.value, can_restore: false });
      else if (kind === "restore") {
        if (result.value === null) post("secure_storage_failed", { req_id, error: "KEY_NOT_FOUND" });
        else post("secure_storage_key_restored", { req_id, value: result.value });
      } else post(kind === "save" ? "secure_storage_key_saved" : "secure_storage_cleared", { req_id });
    } finally { storageRequests.current.delete(req_id); }
  }

  const loadPreparedThumbnail = sessionActions?.preparedThumbnail;
  useEffect(() => {
    const token = session.current;
    if (!token || !prepared?.hasPreview || !loadPreparedThumbnail) return;
    let active = true;
    void loadPreparedThumbnail(token, prepared.confirmation).then((photo) => {
      if (active && session.current === token && photo) setPreparedThumbnail(`data:${photo.mime};base64,${photo.base64}`);
    }, () => {});
    return () => { active = false; };
  }, [loadPreparedThumbnail, prepared]);

  function finishPrepared(error?: string) {
    handlingPrepared.current = false;
    sendingPrepared.current = false;
    setPrepared(undefined);
    setPreparedThumbnail(undefined);
    setPreparedChat(undefined);
    setPreparedTopic(undefined);
    setPreparedBusy(false);
    if (error) post("prepared_message_failed", { error });
    else post("prepared_message_sent", null);
  }

  async function reviewPrepared(payload: unknown) {
    if (handlingPrepared.current) return;
    if (!navigator.userActivation?.isActive) {
      post("prepared_message_failed", { error: "USER_DECLINED" });
      return;
    }
    const token = session.current;
    const id = payload && typeof payload === "object" && "id" in payload ? payload.id : undefined;
    setPreparedError("");
    if (!token || !sessionActions?.previewPreparedMessage || !sessionActions.preparedChats || !sessionActions.sendPreparedMessage
      || typeof id !== "string" || !id || id.length > 256) {
      finishPrepared("MESSAGE_SEND_FAILED");
      return;
    }
    handlingPrepared.current = true;
    const preview = await sessionActions.previewPreparedMessage(token, id).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (preview && "confirmation" in preview) {
      setPrepared(preview);
      return;
    }
    setPreparedError(preview?.error === "ID_EXPIRED" ? "The prepared message expired."
      : preview?.error === "ID_INVALID" ? "The prepared message is invalid." : "Could not open the prepared message.");
    finishPrepared(preview?.error ?? "MESSAGE_SEND_FAILED");
  }

  async function sendPrepared() {
    const token = session.current;
    const send = sessionActions?.sendPreparedMessage;
    if (!token || !send || !prepared || !preparedChat || (preparedChat.forum && !preparedTopic) || sendingPrepared.current) return;
    sendingPrepared.current = true;
    setPreparedBusy(true);
    const result = await send(token, prepared.confirmation, preparedChat.id, preparedChat.name, preparedTopic).catch(() => "unknown" as const);
    if (!active.current || session.current !== token) return;
    if (result !== "sent") setPreparedError(result === "unknown"
      ? "Telegram did not confirm delivery. Check the destination before retrying." : "Could not send the prepared message.");
    finishPrepared(result === "sent" ? undefined : "MESSAGE_SEND_FAILED");
  }

  function finishChatRequest(requestId: string, error?: string) {
    handlingChatRequest.current = false;
    sendingChatRequest.current = false;
    setChatRequest(undefined);
    setRequestedChats([]);
    setChatRequestBusy(false);
    post(error ? "requested_chat_failed" : "requested_chat_sent", { req_id: requestId, ...(error && { error }) });
  }

  async function reviewChatRequest(payload: unknown) {
    const requestId = miniAppRequestId(payload);
    if (!requestId || handlingChatRequest.current) return;
    const token = session.current;
    const preview = sessionActions?.previewChatRequest;
    if (!token || minimizedRef.current || !preview) {
      finishChatRequest(requestId, "UNSUPPORTED");
      return;
    }
    handlingChatRequest.current = true;
    setChatRequestStatus("");
    const result = await preview(token, requestId).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (result && "confirmation" in result) {
      const supported = result.kind === "managedBot" ? !!sessionActions?.createManagedBot
        : !!sessionActions?.findRequestedChats && !!sessionActions.shareRequestedChats;
      if (supported) setChatRequest({ ...result, requestId });
      else finishChatRequest(requestId, "UNSUPPORTED");
    }
    else finishChatRequest(requestId, result?.error ?? "REQUEST_UNAVAILABLE");
  }

  async function shareRequestedChats() {
    const token = session.current;
    const share = sessionActions?.shareRequestedChats;
    if (!token || !share || !chatRequest || chatRequest.kind === "managedBot" || !requestedChats.length || sendingChatRequest.current) return;
    sendingChatRequest.current = true;
    setChatRequestBusy(true);
    const selected = requestedChats.map(({ id, name }) => ({ id, name }));
    const result = await share(token, chatRequest.confirmation, selected).catch(() => "unknown" as const);
    if (!active.current || session.current !== token) return;
    if (result !== "sent") setChatRequestStatus(result === "unknown" ? "Telegram did not confirm sharing. Check with the bot before retrying."
      : "Could not share the selected Telegram chats.");
    finishChatRequest(chatRequest.requestId, result === "sent" ? undefined : "REQUEST_UNAVAILABLE");
  }

  async function createManagedBot(draft: ManagedBotDraft) {
    const token = session.current;
    const create = sessionActions?.createManagedBot;
    if (!token || !create || chatRequest?.kind !== "managedBot" || sendingChatRequest.current) return;
    sendingChatRequest.current = true;
    setChatRequestBusy(true);
    setChatRequestStatus("");
    const result = await create(token, chatRequest.confirmation, draft).catch(() => "unknown" as const);
    if (!active.current || session.current !== token) return;
    if (result === "usernameUnavailable") {
      setChatRequestStatus("Telegram did not accept this username. Try another one.");
      sendingChatRequest.current = false;
      setChatRequestBusy(false);
      return;
    }
    const status = {
      createdAndShared: `Created @${draft.username} and shared it with the managing bot.`,
      createdUnconfirmed: `Created @${draft.username}. Telegram did not confirm sharing it with the managing bot.`,
      limitReached: "You have reached Telegram’s limit for owned bots.",
      failed: "Could not create the managed bot.",
      unknown: "Telegram did not confirm creation. Check whether the bot exists before trying again.",
    }[result];
    setChatRequestStatus(status);
    finishChatRequest(chatRequest.requestId, result === "createdAndShared" ? undefined : "REQUEST_UNAVAILABLE");
  }

  async function createRequestedChat(title: string, username?: string) {
    const token = session.current;
    const create = sessionActions?.createRequestedChat;
    if (!token || !create || !chatRequest || chatRequest.kind === "managedBot" || !chatRequest.creation || sendingChatRequest.current) return;
    sendingChatRequest.current = true;
    setChatRequestBusy(true);
    setChatRequestStatus("");
    const result = await create(token, chatRequest.confirmation, title, username).catch(() => ({ state: "unknown" as const }));
    if (!active.current || session.current !== token) return;
    if (result.state === "usernameUnavailable") {
      setChatRequest({ ...chatRequest, ...(result.chatCreated && { createdSpace: true as const }) });
      setChatRequestStatus(result.chatCreated ? "The chat exists. Choose another public username or finish setup in Chat details."
        : "Telegram could not use that public username. Check it and try again.");
    } else {
      setChatRequest({ ...chatRequest, creation: undefined });
      if (result.state === "ready") setRequestedChats([result.chat]);
      else setChatRequestStatus(result.state === "createdUnshareable" ? chatRequest.requiresUsername
        ? "The chat was created. Check its public username and sharing eligibility in Telegram."
        : "The chat was created. Telegram could not verify it for this request."
        : result.state === "unknown" ? "Telegram did not confirm creation. Check the chat list before trying again."
          : "Could not create a chat for this Mini App.");
    }
    sendingChatRequest.current = false;
    setChatRequestBusy(false);
  }

  async function invokeCustomMethod(payload: unknown) {
    const requestId = miniAppRequestId(payload);
    if (!requestId || customRequests.current.has(requestId)) return;
    const input = miniAppCustomRequest(payload);
    const token = session.current;
    const invoke = sessionActions?.invokeCustomMethod;
    if (!input || !token || !invoke || customRequests.current.size >= 8) {
      post("custom_method_invoked", { req_id: requestId, error: "Mini App request unavailable." });
      return;
    }
    customRequests.current.add(requestId);
    try {
      const reply = await invoke(token, input.method, input.parameters);
      if (!active.current || session.current !== token) return;
      if (!reply) throw new Error("Mini App request unavailable.");
      const outcome = "error" in reply ? { error: reply.error } : { result: JSON.parse(reply.result) as unknown };
      post("custom_method_invoked", { req_id: requestId, ...outcome });
    } catch {
      if (active.current && session.current === token) {
        post("custom_method_invoked", { req_id: requestId, error: "Mini App request unavailable." });
      }
    } finally { customRequests.current.delete(requestId); }
  }
  function finishDownload(status?: "cancelled" | "downloading", notice = "") {
    checkingDownload.current = false;
    setDownload(undefined);
    setDownloadNotice(notice);
    if (status) post("file_download_requested", { status });
  }
  async function reviewDownload(payload: unknown) {
    if (checkingDownload.current) return;
    const input = miniAppDownloadRequest(payload);
    const token = session.current;
    const check = sessionActions?.checkDownload;
    if (!input || !token || !check) { finishDownload("cancelled"); return; }
    setDownloadNotice("");
    checkingDownload.current = true;
    const verified = await check(token, input.url, input.fileName).catch(() => null);
    if (!active.current || session.current !== token) return;
    if (verified) setDownload({ ...input, bot: verified.bot });
    else finishDownload("cancelled");
  }
  async function requestWriteAccess(confirm: boolean) {
    const token = session.current;
    if (checkingWriteAccess.current) return;
    if (!token || !sessionActions) {
      post("write_access_requested", { status: "cancelled" });
      return;
    }
    checkingWriteAccess.current = true;
    if (confirm) setWritePermission("working");
    try {
      const result = await sessionActions.writeAccess(token, confirm);
      if (!active.current || session.current !== token) return;
      if (!confirm && result === "prompt") {
        setWritePermission("prompt");
        return;
      }
      setWritePermission(undefined);
      post("write_access_requested", { status: result === "allowed" ? "allowed" : "cancelled" });
    } catch {
      if (active.current && session.current === token) {
        setWritePermission(undefined);
        post("write_access_requested", { status: "cancelled" });
      }
    } finally {
      checkingWriteAccess.current = false;
    }
  }

  async function requestPhone(confirm: boolean) {
    const token = session.current;
    if (checkingPhone.current) return;
    if (!token || !sessionActions?.previewPhone || !sessionActions.sharePhone) {
      post("phone_requested", { status: "cancelled" });
      return;
    }
    const stillOpen = () => active.current && session.current === token;
    checkingPhone.current = true;
    setPhoneStatus("");
    if (confirm) setPhoneSending(true);
    try {
      if (!confirm) {
        const review = await sessionActions.previewPhone(token);
        if (!stillOpen()) return;
        if (review) setPhoneReview(review);
        else post("phone_requested", { status: "cancelled" });
        return;
      }
      if (!phoneReview) return;
      const result = await sessionActions.sharePhone(token, phoneReview.confirmation);
      if (!stillOpen()) return;
      if (result === "unknown") setPhoneStatus("Telegram did not confirm delivery. Check the bot chat before trying again.");
      else if (result === "failed") setPhoneStatus("Could not share your phone number with the bot.");
      post("phone_requested", { status: result === "sent" ? "sent" : "cancelled" });
    } catch {
      if (stillOpen()) {
        if (confirm) setPhoneStatus("Telegram did not confirm delivery. Check the bot chat before trying again.");
        post("phone_requested", { status: "cancelled" });
      }
    } finally {
      if (confirm && stillOpen()) {
        setPhoneReview(undefined);
        setPhoneSending(false);
      }
      checkingPhone.current = false;
    }
  }

  function fullscreenAvailable() {
    return document.fullscreenEnabled === true && typeof surface.current?.requestFullscreen === "function";
  }

  async function enterFullscreen() {
    setFullscreenRequested(false);
    if (fullscreenEntry.current) return;
    const element = surface.current;
    if (!fullscreenAvailable() || !element) {
      post("fullscreen_failed", { error: "UNSUPPORTED" });
      return;
    }
    const entry = { cancelled: false };
    fullscreenEntry.current = entry;
    try {
      await element.requestFullscreen();
      if ((entry.cancelled || !active.current) && document.fullscreenElement === element) {
        await document.exitFullscreen();
      }
    } catch {
      if (active.current && (!entry.cancelled || document.fullscreenElement === element)) {
        if (entry.cancelled) {
          fullscreenState.current = true;
          setFullscreen(true);
        }
        post("fullscreen_failed", { error: "UNSUPPORTED" });
      }
    } finally {
      fullscreenEntry.current = undefined;
    }
  }

  async function exitFullscreen() {
    setFullscreenRequested(false);
    if (!fullscreenAvailable()) {
      post("fullscreen_failed", { error: "UNSUPPORTED" });
      return;
    }
    const entry = fullscreenEntry.current;
    if (entry && !fullscreenState.current) {
      entry.cancelled = true;
      post("fullscreen_changed", { is_fullscreen: false });
      return;
    }
    if (document.fullscreenElement !== surface.current) {
      post("fullscreen_changed", { is_fullscreen: false });
      return;
    }
    releaseOrientationLock();
    try { await document.exitFullscreen(); }
    catch { post("fullscreen_failed", { error: "UNSUPPORTED" }); }
  }

  const returnInFlight = useRef(false);
  const returnConsumed = useRef(false);

  const releaseSession = useCallback(() => {
    active.current = false;
    releaseOrientationLock();
    linkRequest.current?.abort();
    const token = session.current;
    session.current = undefined;
    if (token && endSession) void endSession(token).catch(() => undefined);
  }, [endSession, releaseOrientationLock]);
  const closeWindow = useCallback(() => {
    releaseSession();
    setSource(undefined);
    close();
  }, [close, releaseSession]);
  const finishClose = useCallback(() => {
    if (active.current && !payingInvoice.current) closeWindow();
  }, [closeWindow]);
  const checkAgeStatus = useCallback(async () => {
    if (!checkAgeVerification || ageCheckInFlight.current || !active.current || !frame.current) return;
    const revision = frameGeneration.current;
    ageCheckInFlight.current = true;
    setAgeStatus("checking");
    try {
      const confirmed = await checkAgeVerification();
      if (!active.current || frameGeneration.current !== revision) return;
      if (confirmed) finishClose();
      else setAgeStatus("unconfirmed");
    } catch {
      if (active.current && frameGeneration.current === revision) setAgeStatus("failed");
    } finally {
      ageCheckInFlight.current = false;
    }
  }, [checkAgeVerification, finishClose]);

  const subscribeToClosures = sessionActions?.subscribeToClosures;
  useLayoutEffect(() => subscribeToClosures?.((closedSession) => {
    if (!active.current || session.current !== closedSession) return;
    session.current = undefined;
    closeWindow();
  }), [subscribeToClosures, closeWindow]);

  async function payInvoice() {
    const token = session.current;
    if (!invoice || !token || !sessionActions?.payInvoice || payingInvoice.current) return;
    payingInvoice.current = true;
    setInvoiceBusy(true);
    try {
      const status = await sessionActions.payInvoice(token, invoice.details.confirmation).catch(() => "pending" as const);
      if (!active.current || session.current !== token) return;
      setInvoiceStatus(status === "paid" ? "Invoice paid." : status === "failed" ? "Telegram could not complete the payment."
        : "Payment status is unconfirmed. Check your Stars transactions before paying again.");
      setInvoice(undefined);
      invoiceRequest.current = undefined;
      post("invoice_closed", { slug: invoice.slug, status });
    } finally {
      payingInvoice.current = false;
      if (active.current) setInvoiceBusy(false);
    }
  }

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    if (element && !element.open && !minimizedRef.current) element.showModal();
    return releaseSession;
  }, [releaseSession]);
  // Install the frame listener in the same commit that exposes the iframe.
  useLayoutEffect(() => {
    if (!source) return;
    function updateViewport() {
      const element = frame.current;
      if (element && !minimizedRef.current) post("viewport_changed", {
        width: element.clientWidth, height: element.clientHeight, is_state_stable: true, is_expanded: expanded || fullscreenState.current,
      });
    }

    function fullscreenChanged() {
      const current = document.fullscreenElement === surface.current;
      if (current && fullscreenEntry.current?.cancelled) return;
      if (current === fullscreenState.current) return;
      fullscreenState.current = current;
      if (!current) orientationLock.current = undefined;
      setFullscreen(current);
      post("fullscreen_changed", { is_fullscreen: current, ...(current ? { blur_enabled: false } : {}) });
      updateViewport();
    }

    function message(event: MessageEvent) {
      const element = frame.current;
      if (!active.current || frameRevision !== frameGeneration.current || !element?.contentWindow
        || event.origin !== (mediaFrame?.origin ?? "null") || event.source !== element.contentWindow) return;
      const message = miniAppFrameEvent(event.data);
      if (message) recordConsole("app", message.type);
      switch (message?.type) {
        case "web_app_close":
          if (inlineQuery === undefined && !reply && !link && !checkingDownload.current && !returnInFlight.current
            && !handlingPrepared.current && !handlingChatRequest.current && !ageCheckInFlight.current) finishClose();
          break;
        case "web_app_verify_age":
          if (checkAgeVerification && !ageHintSeen.current && !minimizedRef.current && message.payload
            && typeof message.payload === "object" && "passed" in message.payload && message.payload.passed === true) {
            // Frame messages can request a check. The current Telegram session decides the outcome.
            ageHintSeen.current = true;
            void checkAgeStatus();
          }
          break;
        case "web_app_switch_inline_query":
          if (useCurrentChatQuery && session.current) {
            const query = miniAppInlineQuery(message.payload);
            if (query && (!query.types.length || (useOtherChatQuery && sessionActions?.inlineChats && sessionActions.inlineDestination))) {
              setInlineQuery((current) => current ?? query);
            }
          }
          break;
        case "web_app_data_send":
          if (sendData && session.current && !returnConsumed.current) {
            const data = miniAppReplyData(message.payload);
            if (data !== undefined) setReply((current) => current ?? data);
          }
          break;
        case "web_app_open_link":
        case "web_app_open_tg_link": {
          const requested = miniAppRequestedLink(message.type, message.payload);
          if (requested) setLink((current) => current ?? requested);
          break;
        }
        case "web_app_open_invoice": {
          const payload = message.payload;
          const slug = payload && typeof payload === "object" && "slug" in payload ? payload.slug : undefined;
          if (typeof slug !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(slug) || invoiceRequest.current === slug) break;
          const token = session.current;
          const previewInvoice = sessionActions?.previewInvoice;
          if (!token || !previewInvoice || invoiceRequest.current) {
            post("invoice_closed", { slug, status: "failed" });
            break;
          }
          invoiceRequest.current = slug;
          setInvoiceStatus("");
          void (async () => {
            const details = await previewInvoice(token, slug).catch(() => null);
            if (!active.current || session.current !== token) return;
            if (details) {
              setInvoice({ slug, details });
            } else {
              invoiceRequest.current = undefined;
              post("invoice_closed", { slug, status: "failed" });
            }
          })();
          break;
        }
        case "web_app_setup_closing_behavior":
          if (message.payload && typeof message.payload === "object" && "need_confirmation" in message.payload
            && typeof message.payload.need_confirmation === "boolean") setWarnOnClose(message.payload.need_confirmation);
          break;
        case "web_app_ready":
          setFrameLoading(false);
          visible.current = !document.hidden && !minimizedRef.current;
          post("visibility_changed", { is_visible: visible.current });
          updateViewport();
          post("theme_changed", { theme_params: themeParams });
          post("safe_area_changed", frameInsets);
          post("content_safe_area_changed", frameInsets);
          break;
        case "web_app_request_safe_area":
          post("safe_area_changed", frameInsets);
          break;
        case "web_app_request_content_safe_area":
          post("content_safe_area_changed", frameInsets);
          break;
        case "web_app_secure_storage_save_key":
          void secureStorage("save", message.payload);
          break;
        case "web_app_secure_storage_get_key":
          void secureStorage("get", message.payload);
          break;
        case "web_app_secure_storage_clear":
          void secureStorage("clear", message.payload);
          break;
        case "web_app_secure_storage_restore_key":
          void secureStorage("restore", message.payload);
          break;
        case "web_app_send_prepared_message":
          void reviewPrepared(message.payload);
          break;
        case "web_app_request_chat":
          void reviewChatRequest(message.payload);
          break;
        case "web_app_check_location":
          void handleLocation("check");
          break;
        case "web_app_request_location":
          void handleLocation("request");
          break;
        case "web_app_open_location_settings":
          void handleLocation("settings");
          break;
        case "web_app_device_storage_save_key":
          void deviceStorage("save", message.payload);
          break;
        case "web_app_device_storage_get_key":
          void deviceStorage("get", message.payload);
          break;
        case "web_app_device_storage_clear":
          void deviceStorage("clear", message.payload);
          break;
        case "web_app_open_scan_qr_popup": {
          const payload = message.payload;
          const label = payload && typeof payload === "object" && "text" in payload ? payload.text : undefined;
          if (label !== undefined && (typeof label !== "string" || Array.from(label).length > 64)) {
            post("scan_qr_popup_closed");
          } else {
            setQrLabel((current) => current ?? label ?? "");
          }
          break;
        }
        case "web_app_close_scan_qr_popup":
          setQrLabel(undefined);
          break;
        case "web_app_biometry_get_info":
        case "web_app_biometry_request_access":
          reportUnavailableBiometry();
          break;
        case "web_app_biometry_update_token":
        case "web_app_biometry_request_auth":
          if (!biometryReported.current) reportUnavailableBiometry();
          post(message.type === "web_app_biometry_update_token" ? "biometry_token_updated" : "biometry_auth_requested", { status: "failed" });
          break;
        case "web_app_add_to_home_screen":
          post("home_screen_failed", { error: "UNSUPPORTED" });
          break;
        case "web_app_check_home_screen":
          post("home_screen_checked", { status: "unsupported" });
          break;
        case "web_app_start_accelerometer":
        case "web_app_stop_accelerometer":
          post("accelerometer_failed", { error: "UNSUPPORTED" });
          break;
        case "web_app_start_gyroscope":
        case "web_app_stop_gyroscope":
          post("gyroscope_failed", { error: "UNSUPPORTED" });
          break;
        case "web_app_start_device_orientation":
        case "web_app_stop_device_orientation":
          post("device_orientation_failed", { error: "UNSUPPORTED" });
          break;
        case "web_app_request_emoji_status_access":
          void reviewEmojiAccess();
          break;
        case "web_app_set_emoji_status":
          void reviewEmojiStatus(message.payload);
          break;
        case "web_app_read_text_from_clipboard":
          void reviewClipboard(message.payload);
          break;
        case "web_app_request_phone":
          if (!phoneReview && !writePermission) void requestPhone(false);
          break;
        case "web_app_request_write_access":
          if (!writePermission && !phoneReview) void requestWriteAccess(false);
          break;
        case "web_app_request_file_download":
          void reviewDownload(message.payload);
          break;
        case "web_app_invoke_custom_method":
          void invokeCustomMethod(message.payload);
          break;
        case "web_app_open_popup": {
          if (popupOpen.current) break;
          const requested = miniAppPopup(message.payload);
          const now = performance.now();
          popupTimes.current = popupTimes.current.filter((time) => now - time < 3000);
          if (!requested || popupTimes.current.length >= 3) {
            post("popup_closed");
            break;
          }
          popupTimes.current.push(now);
          popupOpen.current = true;
          setPopup(requested);
          break;
        }
        case "web_app_expand":
          if (expanded) updateViewport();
          else setExpanded(true);
          break;
        case "web_app_request_fullscreen":
          if (fullscreenState.current) post("fullscreen_failed", { error: "ALREADY_FULLSCREEN" });
          else if (!fullscreenAvailable()) post("fullscreen_failed", { error: "UNSUPPORTED" });
          else if (!fullscreenEntry.current) setFullscreenRequested(true);
          break;
        case "web_app_exit_fullscreen":
          void exitFullscreen();
          break;
        case "web_app_toggle_orientation_lock":
          if (visible.current) lockOrientation(message.payload);
          break;
        case "web_app_hide_keyboard": {
          const keyboard = (navigator as Navigator & { virtualKeyboard?: { hide?: () => void } }).virtualKeyboard;
          if (visible.current && document.activeElement === element) keyboard?.hide?.();
          break;
        }
        case "web_app_trigger_haptic_feedback": {
          const pattern = miniAppHapticPattern(message.payload);
          const now = performance.now();
          const focus = document.activeElement;
          if (pattern !== undefined && visible.current && navigator.userActivation?.isActive
            && (focus === element || surface.current?.querySelector(".mtg-mini-app-buttons")?.contains(focus))
            && typeof navigator.vibrate === "function" && now - lastHaptic.current >= 120) {
            lastHaptic.current = now;
            navigator.vibrate(pattern);
          }
          break;
        }
        case "web_app_request_viewport":
          updateViewport();
          break;
        case "web_app_request_theme":
          post("theme_changed", { theme_params: themeParams });
          break;
        case "web_app_set_header_color": {
          const payload = message.payload;
          if (payload && typeof payload === "object" && !Array.isArray(payload)
            && !("color" in payload) && !("color_key" in payload)) {
            setHeaderColor(undefined);
            break;
          }
          const color = miniAppColor(payload, windowColors);
          if (color) setHeaderColor(color);
          break;
        }
        case "web_app_set_background_color": {
          const color = miniAppColor(message.payload, windowColors);
          if (color) setBackgroundColor(color);
          break;
        }
        case "web_app_set_bottom_bar_color": {
          const color = miniAppColor(message.payload, bottomBarColors);
          if (color) setBottomBarColor(color);
          break;
        }
        case "web_app_setup_main_button":
          setPrimary(miniAppButton(message.payload));
          break;
        case "web_app_setup_secondary_button":
          setSecondary(miniAppButton(message.payload));
          break;
        case "web_app_setup_back_button":
          setBack(miniAppButtonVisible(message.payload));
          break;
        case "web_app_setup_settings_button":
          setSettings(miniAppButtonVisible(message.payload));
          break;
      }
    }
    window.addEventListener("message", message);
    document.addEventListener("fullscreenchange", fullscreenChanged);
    document.addEventListener("visibilitychange", updateVisibility);
    updateViewport();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updateViewport) : undefined;
    if (frame.current) observer?.observe(frame.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("message", message);
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [source, mediaFrame, frameRevision, finishClose, sendData, useCurrentChatQuery, useOtherChatQuery, inlineQuery, reply, link, expanded, minimized, writePermission, phoneReview, sessionActions,
    checkAgeVerification, checkAgeStatus]);

  async function open(remembered?: MiniAppLaunchPreference) {
    if (!active.current || pending.current || !attachmentReady) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const urlToOpen = "url" in target ? target.url : "";
      const result = attachmentReview ? await launch(urlToOpen, { acceptedTerms, allowWriteAccess }) : await launch(urlToOpen);
      if (!active.current) {
        if (result?.session && endSession) void endSession(result.session).catch(() => undefined);
        return;
      }
      const url = result ? miniAppFrameUrl(result.url) : undefined;
      if (url && new URL(url).origin !== window.location.origin) {
        const origin = new URL(url).origin;
        if (remembered && origin !== remembered.origin) {
          if (result?.session && endSession) void endSession(result.session).catch(() => undefined);
          return;
        }
        const requested = remembered?.media ?? mediaAccess;
        const access = canRequestMedia ? requested : { camera: false, microphone: false };
        const requireSameOrigin = result?.requireSameOrigin === true;
        const needsRelay = requireSameOrigin || access.camera || access.microphone;
        const captureFrame = needsRelay && canRequestMedia
          ? miniAppMediaFrame(url, window.location.origin, access, requireSameOrigin) : undefined;
        if (needsRelay && !captureFrame) {
          if (result?.session && endSession) void endSession(result.session).catch(() => undefined);
          setError(true);
          return;
        }
        requiresOrigin.current = requireSameOrigin;
        setMediaAccess(access);
        setMediaFrame(captureFrame);
        if (!remembered) saveMiniAppLaunchPreference(preferenceKey, { origin, media: access });
        session.current = result?.session;
        setExpanded(result?.mode === "fullSize" || result?.mode === "fullScreen");
        if (result?.mode === "fullScreen" && fullscreenAvailable()) setFullscreenRequested(true);
        setFrameLoading(true);
        setSource(url);
      } else {
        if (result?.session && endSession) void endSession(result.session).catch(() => undefined);
        setError(true);
      }
    } catch {
      if (active.current) setError(true);
    } finally {
      pending.current = false;
      if (active.current) {
        setBusy(false);
        setAutoPending(false);
      }
    }
  }

  useEffect(() => {
    if (!preferenceKey || autoAttempt.current === preferenceKey) return;
    const saved = readMiniAppLaunchPreference(preferenceKey);
    if (!saved) return;
    const timer = setTimeout(() => {
      if (!active.current) return;
      autoAttempt.current = preferenceKey;
      setAutoPending(true);
      void open(saved);
    }, 0);
    return () => clearTimeout(timer);
  }, [preferenceKey]);

  function requestClose() {
    if (sendingChatRequest.current) return;
    if (warnOnClose && source) setConfirmClose(true);
    else finishClose();
  }

  function clearLink() {
    setLink(undefined);
    setLinkFailed(false);
  }

  async function openTelegramLink() {
    if (!link?.telegram || !followTelegram || linkRequest.current) return;
    const requestedApp = miniAppLinkKey(link.url);
    if (requestedApp && "url" in target && requestedApp === miniAppLinkKey(target.url)) {
      clearLink();
      return;
    }
    const controller = new AbortController();
    linkRequest.current = controller;
    setLinkBusy(true);
    try {
      const opened = await followTelegram(link.url, controller.signal,
        ...(link.refreshStickerPack ? [{ refreshStickerPack: true }] as const : []));
      if (!controller.signal.aborted) {
        if (opened) {
          if (document.fullscreenElement === surface.current) await document.exitFullscreen().catch(() => undefined);
          if (!controller.signal.aborted) {
            clearLink();
            setWindowMinimized(true);
          }
        } else setLinkFailed(true);
      }
    } catch {
      if (!controller.signal.aborted) setLinkFailed(true);
    } finally {
      linkRequest.current = undefined;
      if (!controller.signal.aborted) setLinkBusy(false);
    }
  }

  async function returnData() {
    if (!reply || !session.current || !sendData || returnConsumed.current) return;
    returnConsumed.current = true;
    returnInFlight.current = true;
    const token = session.current;
    setReturning(true);
    setReplyStatus("");
    try {
      const result = await sendData(token, reply);
      if (!active.current) return;
      if (result === "sent") {
        finishClose();
      } else setReplyStatus(result === "unknown" ? "Telegram did not confirm delivery. Check the chat before trying again."
        : "Could not return the data to the bot.");
    } catch {
      if (active.current) setReplyStatus("Telegram did not confirm delivery. Check the chat before trying again.");
    } finally {
      returnInFlight.current = false;
      if (active.current) {
        setReply(undefined);
        setReturning(false);
      }
    }
  }

  async function chooseInlineDestination(chat: MiniAppDestinationChat, topic?: ForumTopicTarget) {
    const token = session.current;
    if (!token || !inlineQuery || !sessionActions?.inlineDestination || !useOtherChatQuery || inlineDestinationRequest.current) return;
    setInlineDestinationFailed(false);
    if (chat.forum && !topic) {
      if (sessionActions.inlineTopics) setInlineForum(chat);
      else setInlineDestinationFailed(true);
      return;
    }
    inlineDestinationRequest.current = true;
    setInlineDestinationPending(true);
    try {
      const target = await sessionActions.inlineDestination(token, inlineQuery.types, chat.id, topic);
      if (!active.current || session.current !== token) return;
      if (target?.chat.id === chat.id && (topic
        ? target.topic?.id === topic.id && target.topic.name === topic.name && !target.topic.closed
        : !target.topic) && useOtherChatQuery(target.chat, inlineQuery.query, target.topic)) {
        finishClose();
      } else setInlineDestinationFailed(true);
    } catch {
      if (active.current && session.current === token) setInlineDestinationFailed(true);
    } finally {
      inlineDestinationRequest.current = false;
      if (active.current) setInlineDestinationPending(false);
    }
  }

  const reviewInProgress = inlineQuery !== undefined || returning || !!reply || !!link || confirmClose || !!popup
    || !!phoneReview || !!writePermission || fullscreenRequested || !!download || !!clipboardReview || !!emojiStatusReview
    || !!emojiAccessReview || !!prepared || !!chatRequest || !!locationReview || !!invoice;
  const controlsDisabled = reviewInProgress || confirmReload;
  const nativeLink = miniAppNativeLink(handoffUrl ?? ("url" in target ? target.url : ""));

  function reloadAvailable() {
    return !!source && !reviewInProgress && qrLabel === undefined && frameRevision === frameGeneration.current
      && !checkingWriteAccess.current && !checkingPhone.current && !checkingDownload.current
      && !handlingEmojiAccess.current && !handlingEmojiStatus.current && !handlingPrepared.current && !handlingChatRequest.current
      && !handlingLocation.current && !clipboardRequest.current && !invoiceRequest.current
      && !fullscreenEntry.current && !popupOpen.current && !returnInFlight.current && !ageCheckInFlight.current
      && !customRequests.current.size && !storageRequests.current.size;
  }

  function reloadFrame() {
    if (!reloadAvailable()) {
      setReloadStatus("Wait for the current Mini App request before reloading.");
      return;
    }
    const nextMedia = pendingDeviceChange.current;
    pendingDeviceChange.current = undefined;
    if (source && nextMedia) {
      const needsRelay = requiresOrigin.current || nextMedia.camera || nextMedia.microphone;
      const capture = needsRelay && canRequestMedia
        ? miniAppMediaFrame(source, window.location.origin, nextMedia, requiresOrigin.current) : undefined;
      if (needsRelay && !capture) return;
      setMediaAccess(nextMedia);
      setMediaFrame(capture);
      saveMiniAppLaunchPreference(preferenceKey, { origin: new URL(source).origin, media: nextMedia });
      setDeviceDraft(undefined);
    }
    const revision = ++frameGeneration.current;
    recordConsole("frame", "Frame reloading");
    biometryReported.current = false;
    ageHintSeen.current = false;
    setAgeStatus(undefined);
    setConfirmReload(false);
    setReloadStatus("");
    setWarnOnClose(false);
    setBack(false);
    setSettings(false);
    setPrimary(undefined);
    setSecondary(undefined);
    setHeaderColor(undefined);
    setBackgroundColor(undefined);
    setBottomBarColor(undefined);
    setPhoneStatus("");
    setReplyStatus("");
    setInvoiceStatus("");
    setChatRequestStatus("");
    setFrameLoading(true);
    setFrameRevision(revision);
  }

  function cancelReload() {
    pendingDeviceChange.current = undefined;
    setConfirmReload(false);
  }

  function requestReload() {
    if (warnOnClose && reloadAvailable()) {
      setReloadStatus("");
      setConfirmReload(true);
    }
    else reloadFrame();
  }

  function appButton(button: MiniAppButton | undefined, event: "main_button_pressed" | "secondary_button_pressed") {
    if (!button) return null;
    const secondary = event === "secondary_button_pressed";
    const backgroundColor = button.color ?? (secondary
      ? bottomBarColor ?? themeParams.bottom_bar_bg_color : themeParams.button_color);
    const preferredText = button.textColor ?? (secondary ? themeParams.button_color : themeParams.button_text_color);
    const style = { backgroundColor, color: miniAppContrastColor(backgroundColor, preferredText) };
    return <button key={event} type="button" className="mtg-action" disabled={!button.active || controlsDisabled}
      style={style} aria-busy={button.progress} data-shine={button.shine || undefined} onClick={() => post(event)}>
      {button.iconCustomEmojiId && loadEmoji && <span aria-hidden="true" className="mtg-mini-app-button-icon">
        <InlineCustomEmoji key={button.iconCustomEmojiId} id={button.iconCustomEmojiId} label="" load={loadEmoji} />
      </span>}
      <bdi>{button.text}</bdi>{button.progress && "…"}
    </button>;
  }

  const mainButton = appButton(primary, "main_button_pressed");
  const secondaryButton = appButton(secondary, "secondary_button_pressed");
  const buttons = secondary?.position === "right" || secondary?.position === "bottom"
    ? [mainButton, secondaryButton] : [secondaryButton, mainButton];

  return <>
    {minimized && !onMinimizedChange && <button type="button" className="mtg-action mtg-mini-app-resume" onClick={() => setWindowMinimized(false)}>{tr("Resume Mini App ")}<bdi>{appLabel}</bdi>
    </button>}
    <dialog className="mtg-mini-app" data-expanded={expanded} data-launched={!!source} data-agent-panel={agentPanel}
    data-presentation={split ? "split" : "modal"} aria-modal={!split} aria-label={tr("Telegram Mini App")} ref={dialog}
    onClose={(event) => {
      if (event.target === event.currentTarget && !changingPresentation.current && !minimizedRef.current && !event.currentTarget.open) finishClose();
    }}
    onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (confirmReload) cancelReload();
      else if (deviceDraft) setDeviceDraft(undefined);
      else if (consoleOpen) setConsoleOpen(false);
      else if (agentPanel) setAgentPanel(false);
      else requestClose();
    }}>
    <div ref={surface} className="mtg-mini-app-surface">
    <header className="mtg-mini-app-titlebar" style={headerColor ? { backgroundColor: headerColor, color: miniAppContrastColor(headerColor) } : undefined}>
      {back && <Button variant="ghost" size="icon" type="button" aria-label={tr("Mini App back")} disabled={controlsDisabled}
        onClick={() => post("back_button_pressed")}><ArrowLeft size={17} aria-hidden="true" /></Button>}
      <span className="mtg-mini-app-mark" aria-hidden="true"><LayoutGrid size={18} /></span>
      <strong><bdi>{appLabel}</bdi></strong>
      <div className="mtg-mini-app-titlebar-actions">
        {source && session.current && sessionActions?.agentGrant &&
          <Button className="mtg-mini-app-agent-toggle" variant="outline" size="sm" type="button" aria-expanded={agentPanel}
            aria-label={tr("Mini App agent access")} onClick={() => setAgentPanel((open) => !open)}>
            <Sparkles size={16} aria-hidden="true" /><span>{tr("Mini App agent access")}</span>
          </Button>}
        {source && canRequestMedia && <Button variant="ghost" size="icon" type="button" aria-label={tr("Mini App device settings")}
          aria-expanded={!!deviceDraft} disabled={controlsDisabled}
          onClick={() => setDeviceDraft(deviceDraft ? undefined : mediaAccess)}><SlidersHorizontal size={17} aria-hidden="true" /></Button>}
        {settings && <Button variant="ghost" size="icon" type="button" aria-label={tr("Mini App settings")} disabled={controlsDisabled}
          onClick={() => post("settings_button_pressed")}><Settings size={17} aria-hidden="true" /></Button>}
        {source && !fullscreen && <Button variant="ghost" size="icon" type="button" aria-label={tr("Minimize Mini App")}
          disabled={controlsDisabled || qrLabel !== undefined} onClick={() => setWindowMinimized(true)}><Minus size={17} aria-hidden="true" /></Button>}
        {source && !fullscreen && <Button variant="ghost" size="icon" type="button"
          aria-label={tr(split ? "Open Mini App as a modal" : "Open Mini App in split view")}
          aria-pressed={split} disabled={controlsDisabled} onClick={changePresentation}>
          {split ? <PanelRightClose size={17} aria-hidden="true" /> : <PanelRightOpen size={17} aria-hidden="true" />}
        </Button>}
        {source && (!split || fullscreen) && <Button variant="ghost" size="icon" type="button"
          aria-label={tr(fullscreen ? "Exit full screen" : expanded ? "Restore window" : "Expand Mini App")}
          onClick={() => fullscreen ? void exitFullscreen() : setExpanded(!expanded)}>
          {fullscreen || expanded ? <Minimize size={17} aria-hidden="true" /> : <Maximize size={17} aria-hidden="true" />}
        </Button>}
        {source && <details className="mtg-mini-app-window-menu">
          <summary aria-label={tr("Mini App options")}><Ellipsis size={18} aria-hidden="true" /></summary>
          <div>
            <button type="button" disabled={controlsDisabled || qrLabel !== undefined}
              onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; requestReload(); }}>
              {tr("Reload Mini App")}
            </button>
            <button type="button" aria-pressed={consoleOpen}
              onClick={(event) => {
                const menu = event.currentTarget.closest("details");
                if (menu) menu.open = false;
                setConsoleOpen(!consoleOpen);
              }}>{tr("WebApp event console")}</button>
            {nativeLink && !controlsDisabled && qrLabel === undefined &&
              <a href={nativeLink} rel="noreferrer">{tr("Open Mini App in Telegram")}</a>}
            {"url" in target && <a href={target.url} target="_blank" rel="noopener noreferrer">{tr("Open original Telegram link")}</a>}
          </div>
        </details>}
        <Button variant="ghost" size="icon" type="button" aria-label={tr("Close Mini App")}
          disabled={chatRequestBusy || confirmReload} onClick={requestClose}><X size={19} aria-hidden="true" /></Button>
      </div>
    </header>
    {splitNotice && <p className="mtg-mini-app-split-notice" role="status">{tr("Another Mini App is already open in split view.")}</p>}
    {source && deviceDraft && <section className="mtg-mini-app-consent mtg-mini-app-device-settings" aria-label={tr("Mini App device settings")}>
      <fieldset disabled={controlsDisabled}>
        <legend>{tr("Mini App device settings")}</legend>
        <label><input type="checkbox" checked={deviceDraft.camera}
          onChange={(event) => setDeviceDraft({ ...deviceDraft, camera: event.currentTarget.checked })} />{tr(" Allow camera")}</label>
        <label><input type="checkbox" checked={deviceDraft.microphone}
          onChange={(event) => setDeviceDraft({ ...deviceDraft, microphone: event.currentTarget.checked })} />{tr(" Allow microphone")}</label>
      </fieldset>
      <div className="mtg-mini-app-device-actions">
        <Button type="button" disabled={controlsDisabled || !reloadAvailable() ||
          (mediaAccess.camera === deviceDraft.camera && mediaAccess.microphone === deviceDraft.microphone)}
          onClick={() => { pendingDeviceChange.current = deviceDraft; requestReload(); }}>{tr("Save and reload Mini App")}</Button>
        <Button type="button" variant="ghost" disabled={confirmReload} onClick={() => setDeviceDraft(undefined)}>{tr("Cancel")}</Button>
      </div>
    </section>}
    {source ? <div className="mtg-mini-app-layout"><div className="mtg-mini-app-frame" data-loading={frameLoading}>
      <iframe key={frameRevision} ref={frame} src={mediaFrame ? undefined : source} srcDoc={mediaFrame?.document}
        title={tr("Telegram Mini App content")} sandbox={mediaFrame ? "allow-scripts allow-same-origin" : "allow-scripts"}
        style={{ backgroundColor }} onLoad={(event) => {
          if (event.currentTarget !== frame.current) return;
          setFrameLoading(false);
          recordConsole("frame", "Frame load event");
        }}
        referrerPolicy="no-referrer" allow={mediaFrame?.allow ?? miniAppNoMediaPolicy} />
      {frameLoading && <p role="status">{tr("Loading Mini App…")}</p>}
    </div>
    {session.current && sessionActions?.agentGrant && <MiniAppAgentPanel key={session.current} session={session.current}
      actions={sessionActions} visible={agentPanel} active={!minimized}
      snapshot={{ label: appLabel.slice(0, 256), ready: !frameLoading, back, settings }}
      goBack={() => {
        if (!active.current || !dialog.current?.open || minimizedRef.current || !back || controlsDisabled
          || frameLoading || frameRevision !== frameGeneration.current || !frame.current?.contentWindow) return false;
        post("back_button_pressed");
        return true;
      }} />}
    </div>
      : autoPending ? <div className="mtg-mini-app-consent"><p role="status">{tr("Opening Mini App…")}</p></div>
      : <div className="mtg-mini-app-consent">
        <p>{tr("Opening this Mini App shares your Telegram profile with the app.")}{sendData ? tr(" You can review any data it asks to send to the bot.")
            : attachmentDestination ? <>{tr(" It can return a message on your behalf to ")}<bdi>{attachmentDestination.chat}</bdi>
              {attachmentDestination.topic && <> › <bdi>{attachmentDestination.topic}</bdi></>}.</>
            : !attachmentReview && !checkAgeVerification && "label" in target && tr(" It can return a message to this chat on your behalf.")}</p>
        {attachmentReview?.requireTerms && <p>{attachmentReview.installed ? tr("This app is provided by a third party.")
          : tr("This third-party app will be installed in your Telegram account.")}</p>}
        {attachmentReview?.requireTerms && <p><label><input type="checkbox" checked={acceptedTerms} disabled={busy}
          onChange={(event) => setAcceptedTerms(event.currentTarget.checked)} />{tr(" I accept the Mini App terms.")}</label>{" "}
          <a href="https://telegram.org/tos/mini-apps" target="_blank" rel="noopener noreferrer">{tr("View Telegram’s Mini App terms")}</a></p>}
        {attachmentReview?.requestWriteAccess && <p><label><input type="checkbox" checked={allowWriteAccess} disabled={busy}
          onChange={(event) => setAllowWriteAccess(event.currentTarget.checked)} />{tr(" Allow this bot to send me messages.")}</label></p>}
        {canRequestMedia && <fieldset disabled={busy}>
          <legend>{tr(preferenceKey ? "Device access for this Mini App" : "Device access for this Mini App session")}</legend>
          <label><input type="checkbox" checked={mediaAccess.camera}
            onChange={(event) => setMediaAccess({ ...mediaAccess, camera: event.currentTarget.checked })} />{tr(" Allow camera")}</label>
          <label><input type="checkbox" checked={mediaAccess.microphone}
            onChange={(event) => setMediaAccess({ ...mediaAccess, microphone: event.currentTarget.checked })} />{tr(" Allow microphone")}</label>
        </fieldset>}
        <button type="button" className="mtg-action" disabled={busy || !attachmentReady} onClick={() => void open()}>
          {attachmentReview && !attachmentReview.installed ? tr("Install and open Mini App") : tr("Open Mini App")}</button>
        {busy && <p role="status">{tr("Opening Mini App…")}</p>}
        {error && <p role="alert">{tr("This Mini App could not open in BB.")}</p>}
      </div>}
    {source && consoleOpen && <MiniAppConsole origin={new URL(source).origin} read={readConsole}
      clear={clearConsole} close={() => setConsoleOpen(false)} />}
    {source && ageStatus && <section aria-label={tr("Telegram age verification")}>
      <p role="status">{ageStatus === "checking" ? tr("Checking verification with Telegram…")
        : ageStatus === "failed" ? tr("Could not check verification status.") : tr("Telegram has not confirmed age verification yet.")}</p>
      {ageStatus !== "checking" && <button type="button" className="mtg-action"
        onClick={() => void checkAgeStatus()}>{tr("Check verification status")}</button>}
    </section>}
    {source && (primary || secondary) && <div className="mtg-mini-app-buttons" data-position={secondary?.position} style={{ backgroundColor: bottomBarColor }}>
      {buttons}
    </div>}
    {emojiAccessReview && !confirmClose && <section aria-label={tr("Mini App emoji status permission")}>
      <p>{tr("Allow ")}<bdi>{emojiAccessReview.bot}</bdi>{tr(" to change your Telegram emoji status after you close this Mini App?")}</p>
      <button type="button" className="mtg-action" disabled={emojiAccessBusy} onClick={() => void applyEmojiAccess()}>{tr("Allow emoji status access")}</button>
      <button type="button" className="mtg-action" disabled={emojiAccessBusy} onClick={() => finishEmojiAccess(false)}>{tr("Cancel emoji status access")}</button>
    </section>}
    {emojiStatusReview && !confirmClose && <section aria-label={tr("Mini App emoji status request")}>
      <p>{emojiStatusReview.emoji === null ? tr("Remove your Telegram emoji status?") : tr("Set your Telegram emoji status?")}
        {emojiStatusReview.emoji && (loadEmoji
          ? <InlineCustomEmoji id={emojiStatusReview.emoji} label={emojiStatusReview.label || tr("Requested emoji")} load={loadEmoji} />
          : <bdi>{emojiStatusReview.label || tr("Requested emoji")}</bdi>)}</p>
      {emojiStatusReview.emoji && <p>{emojiStatusReview.duration
        ? new Intl.NumberFormat(undefined, { style: "unit", unit: "second", unitDisplay: "long" }).format(emojiStatusReview.duration)
        : tr("Until you change it")}</p>}
      <button type="button" className="mtg-action" disabled={emojiStatusBusy} onClick={() => void applyEmojiStatus()}>
        {emojiStatusReview.emoji === null ? tr("Remove emoji status") : tr("Set emoji status")}
      </button>
      <button type="button" className="mtg-action" disabled={emojiStatusBusy} onClick={() => {
        handlingEmojiStatus.current = false;
        setEmojiStatusReview(undefined);
        post("emoji_status_failed", { error: "USER_DECLINED" });
      }}>{tr("Cancel emoji status request")}</button>
    </section>}
    {locationReview && !confirmClose && <section aria-label={tr("Mini App location access")}>
      <p>{locationReview.settings ? tr("Location permission for") : tr("Share your current location with")} <bdi>{locationReview.bot}</bdi>
        {locationReview.settings ? "." : "?"}</p>
      <button type="button" className="mtg-action" disabled={locationBusy}
        onClick={() => void chooseLocation("allowed")}>{tr("Allow location")}</button>
      <button type="button" className="mtg-action" disabled={locationBusy}
        onClick={() => void chooseLocation("denied")}>{tr("Deny location")}</button>
      {locationReview.settings && <button type="button" className="mtg-action" disabled={locationBusy}
        onClick={() => void chooseLocation("ask")}>{tr("Ask next time")}</button>}
      <button type="button" className="mtg-action" disabled={locationBusy}
        onClick={() => void chooseLocation()}>{tr("Cancel location request")}</button>
    </section>}
    {clipboardReview && !confirmClose && <ClipboardReview bot={clipboardReview.bot} finish={finishClipboard} />}
    {invoice && !confirmClose && <section aria-label={tr("Mini App invoice")}>
      <h3><bdi>{invoice.details.title}</bdi></h3>
      {invoice.details.description && <p dir="auto">{invoice.details.description}</p>}
      <p>{invoice.details.stars.toLocaleString(uiLocale)}{tr(" Stars")}{invoice.details.billingPeriodSeconds
        ? tr(" every {0}", [formatStarBillingPeriod(invoice.details.billingPeriodSeconds)]) : ""}</p>
      {invoice.details.billingPeriodSeconds && <p>{tr("Telegram will charge this amount again each billing period until you cancel.")}</p>}
      {sessionActions?.payInvoice
        ? <button type="button" className="mtg-action" disabled={invoiceBusy} onClick={() => void payInvoice()}>
          {invoiceBusy ? tr("Confirming payment…") : invoice.details.billingPeriodSeconds ? tr("Confirm recurring Stars payment") : tr("Confirm Stars payment")}
        </button>
        : <p>{tr("Payment is unavailable in BB.")}</p>}
      <button type="button" className="mtg-action" disabled={invoiceBusy} onClick={() => {
        invoiceRequest.current = undefined;
        setInvoice(undefined);
        post("invoice_closed", { slug: invoice.slug, status: "cancelled" });
      }}>{tr("Close invoice")}</button>
    </section>}
    {invoiceStatus && <p role="status">{tr(invoiceStatus)}</p>}
    {phoneReview && !confirmClose && <section aria-label={tr("Share phone number")}>
      <p>{tr("Send your Telegram phone number to ")}<bdi>{phoneReview.bot}</bdi>?</p>
      <button type="button" className="mtg-action" disabled={phoneSending} onClick={() => void requestPhone(true)}>{tr("Share phone number")}</button>
      <button type="button" className="mtg-action" disabled={phoneSending} onClick={() => {
        setPhoneReview(undefined);
        post("phone_requested", { status: "cancelled" });
      }}>{tr("Cancel phone request")}</button>
    </section>}
    {phoneStatus && <p role="status">{tr(phoneStatus)}</p>}
    {writePermission && !confirmClose && <section aria-label={tr("Mini App bot messaging permission")}>
      <p>{tr("Allow this Mini App’s bot to send you Telegram messages?")}</p>
      <button type="button" className="mtg-action" disabled={writePermission === "working"}
        onClick={() => void requestWriteAccess(true)}>{tr("Allow bot messages")}</button>
      <button type="button" className="mtg-action" disabled={writePermission === "working"} onClick={() => {
        setWritePermission(undefined);
        post("write_access_requested", { status: "cancelled" });
      }}>{tr("Cancel permission request")}</button>
    </section>}
    {fullscreenRequested && !confirmClose && <section aria-label={tr("Mini App fullscreen request")}>
      <p>{tr("Allow this Mini App to enter full screen?")}</p>
      <button type="button" className="mtg-action" onClick={() => void enterFullscreen()}>{tr("Enter full screen")}</button>
      <button type="button" className="mtg-action" onClick={() => {
        setFullscreenRequested(false);
        post("fullscreen_failed", { error: "UNSUPPORTED" });
      }}>{tr("Cancel full screen")}</button>
    </section>}
    {reloadStatus && <p role="status">{tr(reloadStatus)}</p>}
    {confirmReload && <section aria-label={tr("Confirm reloading the Mini App")}>
      <p>{tr("Changes that you made may not be saved.")}</p>
      <button type="button" className="mtg-action" onClick={cancelReload}>{tr("Keep Mini App open")}</button>
      <button type="button" className="mtg-action" onClick={reloadFrame}>{tr("Reload anyway")}</button>
    </section>}
    {confirmClose && <section aria-label={tr("Confirm closing the Mini App")}>
      <p>{tr("Close this Mini App? Unsaved changes may be lost.")}</p>
      <button type="button" className="mtg-action" onClick={finishClose}>{tr("Confirm close")}</button>
      <button type="button" className="mtg-action" onClick={() => setConfirmClose(false)}>{tr("Keep open")}</button>
    </section>}
    {preparedError && <p role="alert">{tr(preparedError)}</p>}
    {chatRequestStatus && <p role="alert">{tr(chatRequestStatus)}</p>}
    {chatRequest?.kind === "managedBot" && !confirmClose && <ManagedBotCreation key={chatRequest.confirmation}
      review={chatRequest} busy={chatRequestBusy} submit={(draft) => void createManagedBot(draft)}
      cancel={() => finishChatRequest(chatRequest.requestId, "USER_DECLINED")} />}
    {chatRequest && chatRequest.kind !== "managedBot" && !confirmClose && <section aria-label={tr("Share Telegram chats with bot")}>
      <p><bdi>{chatRequest.bot}</bdi>{tr(" requests ")}{chatRequest.kind === "users"
        ? chatRequest.max === 1 ? tr("a user or bot") : tr("up to {0} users or bots", [chatRequest.max]) : `a ${chatRequest.kind}`}.</p>
      <p>{tr("Telegram will share the selected IDs")}{chatRequest.fields.length > 0 && tr(" and the requested fields ({0})", [chatRequest.fields.join(", ")])}.</p>
      {chatRequest.botAccess?.kind === "member" && <p>{tr("Telegram may add ")}<bdi>{chatRequest.bot}</bdi>{tr(" to the selected chat.")}</p>}
      {chatRequest.botAccess?.kind === "administrator" && <>
        <p>{tr("Telegram may add ")}<bdi>{chatRequest.bot}</bdi>{tr(" to the selected chat and grant it administrator access.")}</p>
        {!!chatRequest.botAccess.rights.length && <ul aria-label={tr("Requested administrator rights")}>
          {chatRequest.botAccess.rights.map((right) => <li key={right}>{miniAppAdministratorRightLabels[right]}</li>)}
        </ul>}
      </>}
      {chatRequest.creation && sessionActions?.createRequestedChat && <NewRequestedChat
        key={chatRequest.confirmation} kind={chatRequest.creation} busy={chatRequestBusy}
        requiresUsername={chatRequest.requiresUsername} createdSpace={chatRequest.createdSpace}
        create={(title, username) => void createRequestedChat(title, username)} />}
      <InlineChatPicker selected={requestedChats} disabled={chatRequestBusy}
        find={(query) => session.current && sessionActions?.findRequestedChats
          ? sessionActions.findRequestedChats(session.current, chatRequest.confirmation, query) : Promise.resolve([])}
        choose={(chat) => setRequestedChats((previous) => {
          if (previous.some(({ id }) => id === chat.id)) return previous.filter(({ id }) => id !== chat.id);
          if (chatRequest.max === 1) return [chat];
          return previous.length < chatRequest.max ? [...previous, chat] : previous;
        })} />
      {!!requestedChats.length && <ul aria-label={tr("Selected Telegram chats")}>
        {requestedChats.map(({ id, name }) => <li key={id}><bdi>{name}</bdi>{" "}
          <button type="button" className="mtg-action" disabled={chatRequestBusy} aria-label={tr("Remove {0}", [name])}
            onClick={() => setRequestedChats((previous) => previous.filter((chat) => chat.id !== id))}>{tr("Remove")}</button></li>)}
      </ul>}
      <button type="button" className="mtg-action" disabled={chatRequestBusy || !requestedChats.length}
        onClick={() => void shareRequestedChats()}>{tr("Confirm sharing")}</button>
      <button type="button" className="mtg-action" disabled={chatRequestBusy}
        onClick={() => finishChatRequest(chatRequest.requestId, "USER_DECLINED")}>{tr("Cancel sharing")}</button>
    </section>}
    {prepared && !confirmClose && <section aria-label={tr("Send prepared Telegram message")}>
      <p><bdi>{prepared.title}</bdi> · {prepared.kind}</p>
      {prepared.description && <p><bdi>{prepared.description}</bdi></p>}
      {prepared.details?.url && <p>{tr("Result link ")}<bdi>{prepared.details.url}</bdi></p>}
      {prepared.details?.address && <p>{tr("Address ")}<bdi>{prepared.details.address}</bdi></p>}
      {prepared.details?.artist && <p>{tr("Artist ")}<bdi>{prepared.details.artist}</bdi></p>}
      {prepared.details?.fileName && <p>{tr("File ")}<bdi>{prepared.details.fileName}</bdi></p>}
      {prepared.details?.sizeBytes && <p>{tr("Size ")}{prepared.details.approximateSize ? tr("about ") : ""}{formatSize(prepared.details.sizeBytes)}</p>}
      {prepared.details?.durationSeconds && <p>{tr("Duration ")}{formatPlaybackTime(prepared.details.durationSeconds)}</p>}
      {prepared.details?.dimensions && <p>{tr("Dimensions ")}{prepared.details.dimensions.width} × {prepared.details.dimensions.height}</p>}
      {preparedThumbnail && <img className="mtg-mini-app-prepared-thumbnail" src={preparedThumbnail} alt={tr("Prepared message thumbnail")} />}
      <p>{tr("This preview shows the bot’s result metadata. Telegram sends the message supplied by the bot.")}</p>
      {preparedChat ? <>
        {preparedChat.forum && !preparedTopic ? <>
          <p>{tr("Choose a topic in ")}<bdi>{preparedChat.name}</bdi>.</p>
          <PreparedTopicPicker key={preparedChat.id}
            find={(query, cursor) => session.current && sessionActions?.preparedTopics
              ? sessionActions.preparedTopics(session.current, prepared.confirmation, preparedChat.id, query, cursor) : Promise.resolve(null)}
            choose={setPreparedTopic} />
        </> : <>
          <p>{tr("Send the bot’s prepared message to ")}<bdi>{preparedChat.name}</bdi>{preparedTopic && <> · <bdi>{preparedTopic.name}</bdi></>}?</p>
          <button type="button" className="mtg-action" disabled={preparedBusy} onClick={() => void sendPrepared()}>{tr("Send prepared message")}</button>
          {preparedTopic && <button type="button" className="mtg-action" disabled={preparedBusy} onClick={() => setPreparedTopic(undefined)}>{tr("Choose another topic")}</button>}
        </>}
        <button type="button" className="mtg-action" disabled={preparedBusy}
          onClick={() => { setPreparedChat(undefined); setPreparedTopic(undefined); }}>{tr("Choose another chat")}</button>
      </> : <InlineChatPicker find={(query) => session.current && sessionActions?.preparedChats
        ? sessionActions.preparedChats(session.current, prepared.confirmation, query) : Promise.resolve([])}
        choose={(chat) => { setPreparedChat(chat); return true; }} />}
      <button type="button" className="mtg-action" disabled={preparedBusy} onClick={() => finishPrepared("USER_DECLINED")}>{tr("Cancel prepared message")}</button>
    </section>}
    {inlineQuery !== undefined && !confirmClose && <section aria-label={tr("Mini App inline query")}>
      <p>{inlineQuery.types.length ? tr("Choose a chat for the bot’s inline query.") : tr("Replace the current draft with the bot’s inline query?")}</p>
      {inlineQuery.query && <p><bdi>{inlineQuery.query}</bdi></p>}
      {inlineQuery.types.length
        ? inlineForum ? <>
          <p>{tr("Choose a topic in ")}<bdi>{inlineForum.name}</bdi>.</p>
          <PreparedTopicPicker key={inlineForum.id} find={(query, cursor) => session.current && sessionActions?.inlineTopics
            ? sessionActions.inlineTopics(session.current, inlineQuery.types, inlineForum.id, query, cursor) : Promise.resolve(null)}
            choose={(topic) => void chooseInlineDestination(inlineForum, topic)} />
          <button type="button" className="mtg-action" disabled={inlineDestinationPending} onClick={() => {
            setInlineForum(undefined);
            setInlineDestinationFailed(false);
          }}>{tr("Choose another chat")}</button>
        </> : <InlineChatPicker find={(query) => session.current && sessionActions?.inlineChats
          ? sessionActions.inlineChats(session.current, inlineQuery.types, query) : Promise.resolve([])}
          choose={(chat) => void chooseInlineDestination(chat)} disabled={inlineDestinationPending} />
        : <button type="button" className="mtg-action" disabled={!useCurrentChatQuery} onClick={() => {
          if (useCurrentChatQuery?.(inlineQuery.query)) finishClose();
        }}>{tr("Use inline query")}</button>}
      {inlineDestinationPending && <p role="status">{tr("Checking the selected destination…")}</p>}
      {inlineDestinationFailed && <p role="alert">{tr("Could not put this query in the selected destination.")}</p>}
      <button type="button" className="mtg-action" disabled={inlineDestinationPending} onClick={() => {
        setInlineForum(undefined);
        setInlineDestinationFailed(false);
        setInlineQuery(undefined);
      }}>{tr("Cancel inline query")}</button>
    </section>}
    {link && !confirmClose && <section aria-label={tr("Mini App link request")}>
      <p><bdi>{link.url}</bdi></p>
      {link.telegram && followTelegram && !linkFailed
        ? <button type="button" className="mtg-action" disabled={linkBusy} onClick={() => void openTelegramLink()}>{tr("Open in BB")}</button>
        : <a href={link.url} target="_blank" rel="noopener noreferrer" onClick={clearLink}>{tr("Open requested link")}</a>}
      {link.instantView && <InstantViewButton local url={link.url} />}
      <button type="button" className="mtg-action" disabled={linkBusy} onClick={clearLink}>{tr("Cancel link")}</button>
    </section>}
    {download && <MiniAppDownloadReview download={download} finish={finishDownload} hidden={confirmClose}
      started={() => post("file_download_requested", { status: "downloading" })} />}
    {downloadNotice && <p role="status">{tr(downloadNotice)}</p>}
    {reply && <section aria-label={tr("Confirm Mini App data")}>
      <p>{tr("Send this data to the bot?")}</p>
      <pre dir="auto">{reply}</pre>
      <button type="button" className="mtg-action" disabled={returning} onClick={() => void returnData()}>{tr("Send data to bot")}</button>
      <button type="button" className="mtg-action" disabled={returning} onClick={() => setReply(undefined)}>{tr("Cancel")}</button>
    </section>}
    {replyStatus && <p role="status">{tr(replyStatus)}</p>}
    {!minimized && qrLabel !== undefined && <MiniAppQrDialog label={qrLabel}
      bot={"label" in target ? target.label : `@${target.bot}`}
      scanned={(data) => post("qr_text_received", { data })}
      close={() => {
        setQrLabel(undefined);
        post("scan_qr_popup_closed");
      }} />}
    {!minimized && popup && <MiniAppPopupDialog popup={popup} finish={(buttonId) => {
      setPopup(undefined);
      post("popup_closed", buttonId === undefined ? {} : { button_id: buttonId });
      popupOpen.current = false;
    }} />}
    {!source && !autoPending && nativeLink && !controlsDisabled && qrLabel === undefined &&
      <a href={nativeLink} className="mtg-action" rel="noreferrer"
        title={tr("Use the camera or microphone in the Telegram app")}>{tr("Open Mini App in Telegram")}</a>}
    {!source && !autoPending && "url" in target && <a href={target.url} target="_blank" rel="noopener noreferrer">{tr("Open original Telegram link")}</a>}
    </div>
  </dialog></>;
}

export type BotMiniAppMenuActions = {
  read: (id: string) => Promise<{ label: string; revision: string } | null>;
  launch: (id: string, revision: string) => Promise<{ url: string; session: string } | null>;
  close: CloseMiniAppSession;
};

export type AttachmentMiniAppActions = {
  list: (id: string, topic?: ForumTopicTarget) => Promise<AttachmentMiniApp[]>;
  launch: (id: string, app: AttachmentMiniApp, topic?: ForumTopicTarget) => ReturnType<LaunchMiniApp>;
  close: CloseMiniAppSession;
};
export type AttachmentMiniAppLinkActions = {
  preview: (url: string, id: string, topic?: ForumTopicTarget) => Promise<AttachmentMiniAppReview | null>;
  chats?: (url: string, query: string) => Promise<Chat[]>;
  destination?: (url: string) => Promise<{ chat: Chat; review: AttachmentMiniAppReview } | null>;
  launch: (url: string, id: string, expected: AttachmentMiniAppReview, consent: AttachmentMiniAppConsent, topic?: ForumTopicTarget) => ReturnType<LaunchMiniApp>;
};

export type SideMenuMiniAppActions = {
  list: () => Promise<AttachmentMiniAppReview[]>;
  launch: (app: AttachmentMiniAppReview, acceptedTerms: boolean) => ReturnType<LaunchMiniApp>;
  manage?: {
    list: () => Promise<InstalledMenuMiniApp[]>;
    remove: (app: InstalledMenuMiniApp) => Promise<ReturnType<typeof schemas.removeMenuMiniApp.output.parse>>;
  };
};

function InstalledMenuMiniApps({ actions }: { actions: NonNullable<SideMenuMiniAppActions["manage"]> }) {
  const { t: tr } = useTelegramLocale();
  const [apps, setApps] = useState<InstalledMenuMiniApp[] | null>();
  const [selected, setSelected] = useState<InstalledMenuMiniApp>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (selected) cancelButton.current?.focus();
    else if (status) result.current?.focus();
    else removeButton.current?.focus();
  }, [selected, status]);
  useEffect(() => {
    let active = true;
    void actions.list().then((rows) => { if (active) setApps(rows); }, () => { if (active) setApps(null); });
    return () => { active = false; };
  }, [actions]);

  async function remove(app: InstalledMenuMiniApp) {
    if (pending) return;
    setPending(true);
    setStatus("");
    try {
      const outcome = await actions.remove(app).catch(() => "unknown" as const);
      if (outcome === "removed") {
        setApps((current) => current?.filter((entry) => entry.botId !== app.botId));
        setStatus("Mini App removed from the Telegram menus.");
      } else if (outcome === "failed") setStatus("Could not remove this Mini App.");
      else {
        setApps(await actions.list().catch(() => null));
        setStatus(outcome === "changed" ? "The Telegram menu changed. Review the current list."
          : "Telegram did not confirm removal. Check the installed apps list.");
      }
    } finally {
      setPending(false);
      setSelected(undefined);
    }
  }

  return <section aria-label={tr("Installed Mini Apps")}>
    {apps === undefined && <p role="status">{tr("Loading installed Mini Apps…")}</p>}
    {apps === null && <p role="alert">{tr("Could not load installed Mini Apps.")}</p>}
    {apps?.length === 0 && <p>{tr("No Mini Apps are installed in the Telegram menus.")}</p>}
    {!!apps?.length && <ul>{apps.map((app) => <li key={app.botId}>
      <bdi>{app.label}</bdi>{" · "}{app.attachmentMenu && app.sideMenu ? tr("Attachment menu and sidebar") : app.attachmentMenu ? tr("Attachment menu") : tr("Sidebar")}{" "}
      <button type="button" className="mtg-action" aria-label={tr("Remove {0}", [app.label])} disabled={!!selected} onClick={(event) => {
        removeButton.current = event.currentTarget;
        setSelected(app);
        setStatus("");
      }}>{tr("Remove")}</button>
    </li>)}</ul>}
    {selected && <section aria-label={tr("Confirm Mini App removal")}>
      <p>{tr("Remove ")}<bdi>{selected.label}</bdi>{tr(" from ")}{selected.attachmentMenu && selected.sideMenu ? tr("the Telegram attachment menu and sidebar")
        : selected.attachmentMenu ? tr("the Telegram attachment menu") : tr("the Telegram sidebar")}?</p>
      <button type="button" className="mtg-action" disabled={pending} onClick={() => void remove(selected)}>{tr("Confirm removal")}</button>{" "}
      <button ref={cancelButton} type="button" className="mtg-action" disabled={pending} onClick={() => setSelected(undefined)}>{tr("Cancel removal")}</button>
    </section>}
    {status && <p ref={result} tabIndex={-1} role="status">{tr(status)}</p>}
  </section>;
}

export function SideMenuMiniAppPicker({ list, manage, choose, close }: {
  list: SideMenuMiniAppActions["list"];
  manage?: SideMenuMiniAppActions["manage"];
  choose: (app: AttachmentMiniAppReview) => void;
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [apps, setApps] = useState<AttachmentMiniAppReview[] | null>();
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    if (managing) return;
    let active = true;
    setApps(undefined);
    void list().then((rows) => { if (active) setApps(rows); }, () => { if (active) setApps(null); });
    return () => { active = false; };
  }, [list, managing]);
  return <dialog ref={dialog} className="mtg-mini-app" aria-label={tr("Sidebar Mini Apps")} onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header><strong>{tr("Sidebar Mini Apps")}</strong><button type="button" className="mtg-action" onClick={close}>{tr("Close app list")}</button></header>
    {manage && <button type="button" className="mtg-action" onClick={() => setManaging(!managing)}>
      {managing ? tr("Back to sidebar apps") : tr("Manage installed apps")}
    </button>}
    {managing && manage ? <InstalledMenuMiniApps actions={manage} /> : <>
    {apps === undefined && <p role="status">{tr("Loading Mini Apps…")}</p>}
    {apps === null && <p role="alert">{tr("Could not load sidebar Mini Apps.")}</p>}
    {apps?.length === 0 && <p role="status">{tr("No Mini Apps are installed in the Telegram side menu.")}</p>}
    {!!apps?.length && <ul>{apps.map((app) => <li key={app.botId}>
      <button type="button" className="mtg-action" onClick={() => choose(app)}><bdi>{app.label}</bdi></button>
    </li>)}</ul>}
    </>}
  </dialog>;
}

export function TelegramChatPickerDialog({ find, findTopics, prepare, close, title, unavailableText }: {
  find: FindInlineChats;
  findTopics?: (chat: Chat, query: string, cursor?: PreparedTopicCursor) => Promise<PreparedTopicPage | null>;
  prepare: (chat: Chat, signal: AbortSignal, topic?: ForumTopicTarget) => Promise<boolean>;
  close: () => void;
  title: string;
  unavailableText: string;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [forum, setForum] = useState<Chat>();
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => { request.current?.abort(); };
  }, []);
  function cancel() {
    request.current?.abort();
    close();
  }
  async function select(chat: Chat, topic?: ForumTopicTarget) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setUnavailable(false);
    const prepared = await prepare(chat, controller.signal, topic).catch(() => false);
    if (controller.signal.aborted) return;
    if (prepared) close();
    else setUnavailable(true);
    request.current = undefined;
    setBusy(false);
  }
  return <dialog ref={dialog} className="mtg-mini-app" aria-label={title}
    onCancel={(event) => { event.preventDefault(); cancel(); }} onClose={cancel}>
    <h2>{title}</h2>
    {forum && findTopics ? <>
      <p>{tr("Choose a topic in ")}<bdi>{forum.name}</bdi>.</p>
      <PreparedTopicPicker key={forum.id} find={(query, cursor) => findTopics(forum, query, cursor)}
        choose={(topic) => void select(forum, topic)} />
      <button type="button" className="mtg-action" disabled={busy} onClick={() => {
        setForum(undefined);
        setUnavailable(false);
      }}>{tr("Choose another chat")}</button>
    </> : <InlineChatPicker find={find} choose={(chat) => {
      if (chat.forum && findTopics) {
        setForum(chat);
        setUnavailable(false);
      } else void select(chat);
    }} disabled={busy} />}
    {busy && <p role="status">{forum ? tr("Checking this topic…") : tr("Checking this chat…")}</p>}
    {unavailable && <p role="alert">{unavailableText}</p>}
    <button type="button" className="mtg-action" onClick={cancel}>{tr("Cancel chat selection")}</button>
  </dialog>;
}

export function AttachmentMiniApps({ id, name, topic, actions, disabled, menu }: {
  id: string; name: string; topic?: ForumTopicTarget; actions: AttachmentMiniAppActions; disabled: boolean; menu?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const miniApp = useMiniAppLauncher();
  const controls = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [apps, setApps] = useState<AttachmentMiniApp[] | null>();
  const topicId = topic?.id;
  const topicName = topic?.name;
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    const destination = topicId !== undefined && topicName !== undefined ? { id: topicId, name: topicName } : undefined;
    void actions.list(id, destination).then((rows) => { if (current) setApps(rows); }, () => { if (current) setApps(null); });
    return () => { current = false; };
  }, [actions, expanded, id, topicId, topicName]);

  return <div onKeyDown={(event) => {
    if (!expanded || !isPlainKey(event, "Escape")) return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" aria-label={tr("Attachment Mini Apps")} title={tr("Attachment Mini Apps")} aria-controls={controls}
      aria-expanded={expanded && !disabled} disabled={disabled} onClick={() => {
      setApps(undefined);
      setExpanded(!expanded);
    }}><LayoutGrid size={17} aria-hidden="true" />{menu && tr("Mini Apps")}</button>
    <section id={controls} className="mtg-attachment-mini-apps" aria-label={tr("Attachment Mini Apps")} hidden={!expanded || disabled}>
      {apps === undefined && <p role="status">{tr("Loading Mini Apps…")}</p>}
      {apps === null && <p role="alert">{tr("Could not load Mini Apps.")}</p>}
      {apps?.length === 0 && <p role="status">{tr("No installed Mini Apps for this chat.")}</p>}
      {apps?.map((app) => <button key={app.botId} type="button" className="mtg-action" aria-haspopup="dialog" onClick={() => {
        setExpanded(false);
        miniApp.open({ target: { label: app.label }, attachmentDestination: { chat: name, topic: topic?.name },
          launch: () => actions.launch(id, app, topic), closeSession: actions.close });
      }}><bdi>{app.label}</bdi></button>)}
    </section>
    {miniApp.dialog}
  </div>;
}

export function BotMiniAppMenu({ id, actions, disabled, name, loadProfile, loadPresence, launchProfile }: {
  id: string; actions?: BotMiniAppMenuActions; disabled: boolean;
  name: string; loadProfile?: (id: string) => Promise<PeerProfile | null>; loadPresence?: (id: string) => Promise<UserPresence>; launchProfile?: LaunchMiniApp;
}) {
  const { t: tr } = useTelegramLocale();
  const [app, setApp] = useState<(MiniAppLaunch & { target: { label: string } }) | null>(null);
  const miniApp = useMiniAppLauncher();
  useEffect(() => {
    let active = true;
    setApp(null);
    async function load() {
      const menu = await actions?.read(id).catch(() => null);
      if (!active) return;
      if (menu && actions) {
        setApp({ target: { label: menu.label }, entryPoint: ["bot-menu", id, menu.revision],
          launch: () => actions.launch(id, menu.revision), closeSession: actions.close });
        return;
      }
      if (!loadProfile || !launchProfile) return;
      if (loadPresence && (await loadPresence(id).catch(() => null))?.state !== "bot") return;
      if (!active) return;
      const profile = await loadProfile(id).catch(() => null);
      if (!active || !profile?.hasMainMiniApp) return;
      const username = profile.usernames[0];
      setApp({ target: { label: username ? `@${username}` : name || "Telegram bot" },
        entryPoint: ["bot-profile", id], launch: () => launchProfile(id),
        handoffUrl: username && `https://t.me/${encodeURIComponent(username)}?startapp` });
    }
    void load();
    return () => { active = false; };
  }, [id, actions, name, loadProfile, loadPresence, launchProfile]);

  if (!app) return null;
  const label = app.entryPoint?.[0] === "bot-menu" ? app.target.label : tr("Open bot app");
  return <>
    <Button type="button" variant="ghost" size="icon" disabled={disabled}
      aria-label={label} aria-haspopup="dialog" onClick={() => miniApp.open(app)}>
      <LayoutGrid size={18} aria-hidden="true" />
    </Button>
    {miniApp.dialog}
  </>;
}
