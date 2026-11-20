// Makosh Mail — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// This file is the BB adapter: it owns RPC, realtime refreshes, navigation and
// the composer, and hands plain data and callbacks to the host-agnostic page
// in src/ui.
import { runAskAct } from "./src/ui/ask-panel.tsx";
import type { SettingsPgpPorts } from "./src/ui/pgp-settings.tsx";
import type { SettingsFilterPorts } from "./src/ui/filters-settings.tsx";
import { ArchiveViewPage, type ArchivePorts } from "./src/ui/archive-view.tsx";
import type { SettingsSubscriptionPorts } from "./src/ui/subscriptions-settings.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_Diff,
  experimental_ImageLightbox,
  experimental_useCodeTheme,
  experimental_saveFile,
  experimental_SourceCode,
  experimental_InfoSection,
  experimental_THREAD_ACTION_GROUPS,
  experimental_THREAD_INFO_SECTION_GROUPS,
  experimental_useQuestionFormHost,
  UrlLink,
  useBbContext,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type ExperimentalBadge,
  type ExperimentalThreadInfoProps,
  type PluginMessageActionContext,
  type PluginNavPanelProps,
  type PluginPendingInteractionProps,
  type PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { GoogleSignInOutcome } from "./src/ui/account-form.tsx";
import { googleSignInFailureText } from "./src/ui/google-sign-in-text.ts";
import type { rpcContract } from "./server.ts";
import type {
  AttachmentMeta,
  DraftView,
  Folder,
  IdentityView,
  MAIL_CHANGED_CHANNEL as MailChangedChannel,
  NEW_MAIL_CHANNEL as NewMailChannel,
  DAY_NOTICE_CHANNEL as DayNoticeChannel,
  MessageAction,
  MessageHeader,
  NewAccountInput,
  OUTBOX_CHANGED_CHANNEL as OutboxChangedChannel,
  OutboxChangedPayload,
  OutboxRow,
  RoleCount,
  StatusView,
  ThreadDetail,
} from "./src/core/index.ts";
import type { BlockRuleView, UnsubscribeInfoView } from "./src/core/model.ts";
import { isRoleMoveAction, roleFolders } from "./src/core/actions.ts";
// undo.ts imports only actions.ts: no zod reaches the bundle (checked on build).
import { UNDO_TOAST_MS, undoResultText, undoToastText, type UndoAction } from "./src/core/undo.ts";
// snooze.ts imports only types: no zod reaches the bundle.
import { snoozeFolderName } from "./src/core/snooze.ts";
import type { ComposerPorts, ComposeWarningKind } from "./src/ui/composer.tsx";
import type { SmtpSettingsInput } from "./src/ui/smtp-dialog.tsx";
import type { DetailsState } from "./src/ui/details-panel.tsx";
import { addBounded, setBounded } from "./src/ui/bounded.ts";
import {
  DEFAULT_FOLDER_PATH,
  inboxPath,
  isInboxView,
  sameView,
  viewKey,
  viewPaths,
  type MailView,
  type RoleName,
} from "./src/ui/folder-list.tsx";
import {
  ALL_ACCOUNTS,
  MailPage,
  type AccountFormRequest,
  type ComposeKind,
  type ComposerState,
  type MailInboxPorts,
  type MailTabsPorts,
  type ReadingState,
  type SearchState,
  type ThreadListState,
} from "./src/ui/mail-page.tsx";
import { outboxStateText, type OutboxAction } from "./src/ui/outbox.tsx";
import { messageToHand, type BodyState } from "./src/ui/reading-pane.tsx";
import { MailSidebar, type MailSidebarState } from "./src/ui/mail-sidebar.tsx";
import {
  draftSubPath,
  parseDraftSubPath,
  parseThreadSubPath,
  parseViewSubPath,
  parseViewTab,
  pageSubPath,
  parsePageSubPath,
  parseSettingsSubPath,
  settingsSubPath,
  parseProjectSubPath,
  parseSavedSearchSubPath,
  projectSubPath,
  savedSearchSubPath,
  type MailPageName,
  threadSubPath,
  viewSubPath,
  viewTabSubPath,
  type ThreadLink,
} from "./src/ui/routes.ts";
import { NEW_MAIL_TOAST_MS, newMailToastPlan } from "./src/ui/new-mail-toasts.ts";
import { TriageCard, type TriageViewResult } from "./src/ui/triage-card.tsx";
import { TriageRow } from "./src/ui/triage-row.tsx";
import { AgentSendCard, type ProposalViewResult } from "./src/ui/agent-send-card.tsx";
import { AgentSendRow } from "./src/ui/agent-send-row.tsx";
import type { ReadingTranslation } from "./src/ui/reading-pane.tsx";
import {
  TRANSLATION_STARTING,
  TranslationBlock,
  type TranslationState,
} from "./src/ui/translation-block.tsx";
import { TranslationSettings } from "./src/ui/translation-settings.tsx";
import { type SettingsAiPorts, type SettingsSection, type TemplateView } from "./src/ui/settings/shared.ts";
import { SettingsPage } from "./src/ui/settings/settings-page.tsx";
import type { PageSettingsPort, SaveResult } from "./src/ui/settings/setting-controls.tsx";
import { pageSettingsOf, pageSettingsPatchSchema, type PageSettings } from "./src/core/page-settings.ts";
import type { LanguageTag } from "./src/core/translate.ts";
import { filterActive, formatUntil, subjectOrPlaceholder, type ListFilter } from "./src/ui/thread-list.tsx";
import {
  preferredMethod,
  UnsubscribeDialog,
  unsubscribeFailureText,
  type UnsubscribeMethod,
} from "./src/ui/unsubscribe-dialog.tsx";
import { SnoozeFolderDialog, type SnoozeFolderRequest } from "./src/ui/snooze-folder-dialog.tsx";
import type { BlockChoice } from "./src/ui/block-dialog.tsx";
import type { AiStartInput } from "./src/core/contract.ts";
import type { AiResultView, ReminderView } from "./src/core/model.ts";
import { AI_ERROR_TEXT, AI_POLL_MS, type AiJobPorts } from "./src/ui/ai-job.ts";
import { categoryLabel, type Category } from "./src/ui/category-chips.tsx";
import type { MailAiPorts } from "./src/ui/mail-page.tsx";
import { daysText } from "./src/ui/reminder-strip.tsx";
import type { TaskPick } from "./src/ui/tasks-dialog.tsx";
import { TodayView } from "./src/ui/today-view.tsx";
import { DAY_NOTICE_TOAST_MS, dayNoticePlan } from "./src/ui/day-notices.ts";
import { TasksView } from "./src/ui/tasks-view.tsx";
import type { MailBbPorts } from "./src/ui/bb-dialogs.tsx";
import type { BbCall, CodeRenderers } from "./src/ui/bb-ports.ts";
import type { BbSettingsValues } from "./src/ui/bb-integration-settings.tsx";
import { DevView } from "./src/ui/dev-view.tsx";
import { ProjectsView } from "./src/ui/projects-view.tsx";
import { ThreadMailSection } from "./src/ui/thread-mail-section.tsx";
import type { RpcOut } from "./src/core/contract.ts";
import type { SavedSearchView } from "./src/core/model.ts";
// history.ts has no imports: nothing else reaches the bundle.
import { emptyStepsNote } from "./src/core/history.ts";
import type { MailSlice3hPorts, ServerSearchState } from "./src/ui/mail-page.tsx";
import type { RailCommand } from "./src/ui/mail-sidebar.tsx";
import type { HistoryState } from "./src/ui/thread-list.tsx";
import { dropAction, dropRefusal, readMovePayload } from "./src/ui/drag-move.ts";
import { SaveSearchDialog, type SavedSearchEdit } from "./src/ui/saved-searches.tsx";
import type { InboxTabView } from "./src/ui/inbox-tabs.tsx";
import type { TypingOptions } from "./src/ui/editor-typing.ts";
import { uploadFile } from "./src/ui/attachments-input.tsx";
import { selectedQuote } from "./src/ui/quick-quote.ts";
import { parsePairs } from "./src/core/autocorrect.ts";
import type { InboxTabsPort } from "./src/ui/settings/tabs-settings.tsx";
import { TAB_NAME_MAX } from "./src/core/inbox-tabs.ts";
import {
  DeleteFolderDialog,
  FolderNameDialog,
  type DeleteCheck,
  type DeleteRequest,
  type FolderNameRequest,
} from "./src/ui/folder-dialogs.tsx";
import { HistoryForgetDialog, type ForgetRequest } from "./src/ui/history-forget-dialog.tsx";
import { LabelsDialog, type LabelsRequest } from "./src/ui/labels-dialog.tsx";
import { FILES_PAGE, FilesView, type FilesFilter } from "./src/ui/files-view.tsx";
import { AttachmentViewer, viewerShows, type ViewerHost, type ViewRequest } from "./src/ui/attachment-viewer.tsx";
import { printDocument, printFileName, printHtml, type PrintMessage } from "./src/ui/print.ts";
// Slice 3i: the link checks import zod-free core modules only (no zod in the page bundle).
import { cleanLink, type CleanLink } from "./src/core/link-clean.ts";
import { addressDomain } from "./src/core/sender-basics.ts";
import { buildKnownDomains } from "./src/core/sender-disguise.ts";
import { LinkDialog } from "./src/ui/link-status.tsx";
import type { SettingsSearchPorts } from "./src/ui/settings/shared.ts";
// The page-side pdf.js engine: pdf.js loads lazily, in a blob: worker only.
import { browserPdfEngine } from "./src/adapters/bb/pdf-page.ts";
import type { RuleRunView } from "./src/core/contract.ts";
import { resolveLanguage, setLanguage, tx, type Language } from "./src/ui/i18n/index.ts";
import { PLUGIN_ACCESS_CHANNEL, type PluginAccessPayload } from "./src/core/plugin-api.ts";
import { GOOGLE_EXTRA_SCOPES, GOOGLE_RIGHT_SCOPE, isGoogleRight, type PluginRight } from "./src/core/plugin-access.ts";
import type { PluginAccessPort } from "./src/ui/settings/plugin-access-section.tsx";

// The channel name is checked against the core constant without importing it
// at runtime: a value import of the core would bundle its zod schemas.
const MAIL_CHANGED_CHANNEL: typeof MailChangedChannel = "mail-changed";
/** BB's highlighter and diff viewer, injected into src/ui as render props (slice 3g, spec resolution 6). */
const HostSourceCode = experimental_SourceCode;
const HostImageLightbox = experimental_ImageLightbox;
const HostDiff = experimental_Diff;
const HostInfoSection = experimental_InfoSection;
const OUTBOX_CHANGED_CHANNEL: typeof OutboxChangedChannel = "outbox-changed";
const NEW_MAIL_CHANNEL: typeof NewMailChannel = "mail-new";
const DAY_NOTICE_CHANNEL: typeof DayNoticeChannel = "mail-day";
/** The Undo window when a row's sendAfter is not known yet. */
const UNDO_WINDOW_MS = 10_000;
/** A queued send further away than this is a scheduled one (slice 3l): no countdown toast. */
const SCHEDULED_TOAST_MS = 30_000;
/** How often a running translation is polled while the page is visible. */
const TRANSLATE_POLL_MS = 400;
const TRANSLATE_MISSING = "Translation needs the Makosh AI plugin";
const PAGE_SIZE = 50;
const MAX_PAGE = 100;
const SEARCH_LIMIT = 50;
/** How often the page asks how a Google sign-in stands while the browser has it. */
const GOOGLE_SIGN_IN_POLL_MS = 1_000;
const SYNC_INDICATOR_MS = 60_000;
/** message_action takes at most this many ids per call; larger batches go in sequence. */
const ACTION_CHUNK = 200;
/** One toast for the undo of the last action, replaced by the next. */
const UNDO_TOAST_ID = "mail-undo";
/** Slice 3i: how long a conversation stays open before its unknown sender checks are fetched (part B I3). */
const SENDER_CHECK_DELAY_MS = 600;
/** sender_check_refresh takes at most this many ids. */
const SENDER_CHECK_BATCH = 50;
/** Most message ids the page remembers as already sent to sender_check_refresh (slice 3i review). */
const SENDER_CHECK_REMEMBERED = 2_000;
/** Most undo ids whose reopen the page remembers (slice 3i review); only recent undos are offered anyway. */
const REOPEN_BY_UNDO_MAX = 20;

/** "Moving back…" gives way to the result at the next mail-changed, or after this long. */
const MOVING_BACK_MAX_MS = 10_000;
/** thread_get calls in flight at once while a selection's messages are collected. */
const COLLECT_CONCURRENCY = 6;
/**
 * mail-changed events closer together than this cause one refresh: opening a
 * conversation with N unread messages publishes N of them.
 */
const REFRESH_DEBOUNCE_MS = 250;
/** A steady stream of events still refreshes at least this often. */
const REFRESH_MAX_WAIT_MS = 2_000;

/** Slice 3h: this page load's id; a drag carries it, and only it is accepted (drag-move.ts). */
const PAGE_ID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `p${Date.now()}${Math.random()}`;
/** Slice 3h: how often a server, history or conversation job is polled. */
const JOB_POLL_MS = 800;
/** Slice 3h: saved search counts follow mail-changed at most this often. */
const SAVED_REFRESH_MS = 30_000;
/** Slice 3h: where the page keeps the folders shown one message per row. */
const UNGROUPED_KEY = "makosh-mail.ungroupedFolders";

/** The grouping key of a view: an account's folder, or a merged role ('*'). */
function groupingKey(view: MailView): string {
  return view.kind === "folder" ? `${view.accountId}\n${view.path}` : `*\n${view.role}`;
}

function readUngrouped(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(UNGROUPED_KEY) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeUngrouped(keys: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(UNGROUPED_KEY, JSON.stringify([...keys]));
  } catch {
    // Private mode or a full quota: the choice lasts until the page closes.
  }
}

const EMPTY_LIST: ThreadListState = {
  threads: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
};
const NO_SEARCH: SearchState = { query: "", hits: [], loading: false, error: null };
const NO_READING: ReadingState = {
  threadId: null,
  detail: null,
  loading: false,
  error: null,
  expandedIds: new Set(),
  bodies: {},
  remoteImageIds: new Set(),
  imageSenders: new Set(),
};
const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_FILTER: ListFilter = {};
const REDIRECTED_TEXT = "The list answered with a redirect, so it may not have unsubscribed you";

/** Undo of these moves mail back (the "Moving back…" toast waits for it). */
function movesMail(action: UndoAction): boolean {
  return action === "move" || action === "snooze" || action === "block" || action === "triage" ||
    action === "spam" || action === "not_spam" || action === "archive" || action === "delete";
}

/** The error's text in the page's language: Mail's own refusals are fixed English sentences the catalog knows. */
function messageOf(error: unknown): string {
  return tx(error instanceof Error && error.message ? error.message : String(error));
}

/** The accountId of a mail-changed payload; undefined when it names none. */
function changedAccount(payload: unknown): string | null | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as { accountId?: unknown }).accountId;
  return typeof value === "string" || value === null ? value : undefined;
}

const OUTBOX_EVENT_STATES = new Set<OutboxChangedPayload["state"]>([
  "queued",
  "held",
  "sending",
  "sent",
  "appending",
  "failed",
  "unknown",
  "sent_no_copy",
  "waiting",
  "done",
  "cancelled",
]);

/** An outbox-changed payload, or null when it is not one. */
function outboxEvent(payload: unknown): OutboxChangedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { accountId, id, state } = payload as Record<string, unknown>;
  if (typeof accountId !== "string" || typeof id !== "string" || typeof state !== "string") return null;
  if (!OUTBOX_EVENT_STATES.has(state as OutboxChangedPayload["state"])) return null;
  return { accountId, id, state: state as OutboxChangedPayload["state"] };
}

/** One toast per send, so each state replaces the last. */
function sendToastId(outboxId: string): string {
  return `makosh-mail-send-${outboxId}`;
}

/** The fallback prompt carries the message text itself (it starts with the untrusted notice). */
function handToAgentPrompt(agentText: string): string {
  return tx("Help me with this email.\n\n{agentText}", { agentText });
}

/** The threads_list scope of a view. */
function scopeOf(view: MailView) {
  return view.kind === "role"
    ? ({ kind: "all", role: view.role } as const)
    : ({ kind: "account", accountId: view.accountId, folder: view.path } as const);
}

/** The message_action source of a view: the folder, or in All accounts the role. */
function sourceOf(view: MailView): { folder: string } | { role: RoleName } {
  return view.kind === "folder" ? { folder: view.path } : { role: view.role };
}

/** Runs `work` on every item with at most `limit` in flight. */
async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

/** A message the action touches, with where it is. */
type ActionItem = { id: string; accountId: string; folder: string; threadId: string };

/** The view an action was started in, kept for the whole action. */
type ViewContext = { view: MailView; folders: Folder[] | null };

/** The folder thread_get prefers for a conversation of `accountId` in a view. */
function folderIn({ view, folders }: ViewContext, accountId: string | null): string {
  if (view.kind === "folder") return view.path;
  const matching = roleFolders(view.role, (folders ?? []).filter((f) => f.accountId === accountId));
  return (matching.find((f) => f.selectable) ?? matching[0])?.path ?? DEFAULT_FOLDER_PATH;
}

/** Whether a message's copy sits in the folder (or role) of a view. */
function inViewOf({ view, folders }: ViewContext, message: MessageHeader): boolean {
  return viewPaths(view, folders ?? [], message.accountId).includes(message.folder);
}

/**
 * Resolution 4 for a batch: Flag flags the newest message of each
 * conversation in the view; Unflag unflags every flagged one. Other actions
 * take every message in the view.
 */
function flagChoice(
  items: readonly ActionItem[],
  details: ReadonlyMap<string, ThreadDetail>,
  action: MessageAction,
  ctx: ViewContext,
): ActionItem[] {
  if (action !== "flag" && action !== "unflag") return [...items];
  const chosen = new Set<string>();
  for (const detail of details.values()) {
    const shown = detail.messages.filter((m) => inViewOf(ctx, m));
    if (action === "flag") {
      const newest = shown.at(-1);
      if (newest !== undefined) chosen.add(newest.id);
    } else {
      for (const m of shown) if (m.isFlagged) chosen.add(m.id);
    }
  }
  return items.filter((item) => chosen.has(item.id));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Saves a ticket's file through BB's own download path; "failed" when it could not start. */
async function saveTicket(ticket: { url: string; fileName: string }): Promise<"started" | "failed"> {
  try {
    return await experimental_saveFile({ fileName: ticket.fileName, url: ticket.url });
  } catch {
    // This BB has no saveFile.
    return "failed";
  }
}

function anchorDownload({ url, fileName }: { url: string; fileName: string }) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Calls `run` once per burst of realtime events on `channel`, REFRESH_DEBOUNCE_MS
 * after the last one (but no later than REFRESH_MAX_WAIT_MS after the first),
 * with every payload of the burst.
 */
function useDebouncedRealtime(channel: string, run: (payloads: unknown[]) => void) {
  const runRef = useRef(run);
  runRef.current = run;
  const pending = useRef<unknown[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstStart = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useRealtime(channel, (payload) => {
    pending.current.push(payload);
    const now = Date.now();
    burstStart.current ??= now;
    if (timer.current !== null) clearTimeout(timer.current);
    const wait = Math.max(
      0,
      Math.min(REFRESH_DEBOUNCE_MS, burstStart.current + REFRESH_MAX_WAIT_MS - now),
    );
    timer.current = setTimeout(() => {
      timer.current = null;
      burstStart.current = null;
      const payloads = pending.current;
      pending.current = [];
      runRef.current(payloads);
    }, wait);
  });
}

/** What the sidebar asks of the Mail page. */
type PageCommand =
  | { kind: "compose" }
  | { kind: "account"; choice: string }
  | { kind: "view"; view: MailView }
  | { kind: "settings" }
  | { kind: "thread"; link: ThreadLink }
  | { kind: "page"; page: MailPageName }
  | { kind: "rail"; command: RailCommand };

/**
 * What the Mail page and its sidebar share while both are mounted (they are
 * separate React trees): the page publishes what the rail draws, and the
 * sidebar sends the owner's picks back. The view itself travels in the URL
 * subPath, so the sidebar navigates on its own when no page listens. With the
 * page open in two panes, the one mounted last serves the sidebar.
 */
const mailPageLink = (() => {
  type Page = { state: MailSidebarState | null; onCommand: (command: PageCommand) => void };
  const pages: Page[] = [];
  const listeners = new Set<() => void>();
  let shown: MailSidebarState | null = null;
  const update = () => {
    const next = pages.at(-1)?.state ?? null;
    if (next === shown) return;
    shown = next;
    for (const listener of listeners) listener();
  };
  return {
    sidebarState: () => shown,
    subscribeSidebar(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** A mounted page; its handle publishes the rail and unregisters it. */
    register(onCommand: (command: PageCommand) => void) {
      const page: Page = { state: null, onCommand };
      pages.push(page);
      return {
        publish(state: MailSidebarState | null) {
          page.state = state;
          update();
        },
        unregister() {
          const at = pages.indexOf(page);
          if (at >= 0) pages.splice(at, 1);
          update();
        },
      };
    },
    /** A Mail page is mounted. */
    mounted: () => pages.length > 0,
    /**
     * A mounted Mail page is visible and lists an Inbox (spec "Toast"): its
     * list updates by itself, so no new-mail toast is needed.
     */
    showsInbox(): boolean {
      const state = shown;
      if (state === null) return false;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      return isInboxView(state.view, state.folders);
    },
    /** False when no page took the command. */
    send(command: PageCommand): boolean {
      const page = pages.at(-1);
      page?.onCommand(command);
      return page !== undefined;
    },
  };
})();

type FolderState = { key: string; folders: Folder[]; roles: RoleCount[]; error: string | null };

/**
 * Slice 3j: the page's language, from the `language` setting ("auto" follows
 * the system). Every slot component calls it first, so the texts it renders
 * (and the helpers they call) are in that language.
 */
function useMailLanguage(): Language {
  const setting = useSettings().values?.language;
  const system = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  const language = resolveLanguage(setting, system);
  setLanguage(language);
  return language;
}

function MailPanel({ subPath }: PluginNavPanelProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();

  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const googleSignInOffered = status?.googleSignIn === true;
  /**
   * An account id or ALL_ACCOUNTS, with the route it was chosen on; null
   * until the owner chooses (All accounts when several).
   */
  const [chosen, setChosen] = useState<{ choice: string; route: number } | null>(null);
  /** Folders of the scope (an account, or ALL_ACCOUNTS), tagged with it. */
  const [folderState, setFolderState] = useState<FolderState | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [list, setList] = useState<ThreadListState>(EMPTY_LIST);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [reading, setReading] = useState<ReadingState>(NO_READING);
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [details, setDetails] = useState<DetailsState | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Slice 3j: the page's own link to the BB server, for the header's status.
  const bbLink = useRealtimeConnectionState();
  const [accountForm, setAccountForm] = useState<AccountFormRequest>(null);
  const [mailComposer, setComposer] = useState<ComposerState | null>(null);
  /** Counts mail-changed refreshes: the drafted-reply strip reads again. */
  const [mailVersion, setMailVersion] = useState(0);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [outboxPending, setOutboxPending] = useState<ReadonlySet<string>>(new Set());
  const [smtpAccountId, setSmtpAccountId] = useState<string | null>(null);

  /**
   * The view the subPath names (a conversation link keeps the view before
   * it), and a counter of subPath changes.
   */
  const route = useRef({ subPath, serial: 0, view: parseViewSubPath(subPath), tab: parseViewTab(subPath) });
  if (route.current.subPath !== subPath) {
    const kept = parseThreadSubPath(subPath) !== null || parseDraftSubPath(subPath) !== null || parseSavedSearchSubPath(subPath) !== null;
    route.current = {
      subPath,
      serial: route.current.serial + 1,
      view: kept ? route.current.view : parseViewSubPath(subPath),
      // Split Inbox: the Inbox tab of the view, kept with it.
      tab: kept ? route.current.tab : parseViewTab(subPath),
    };
  }
  const routeView = route.current.view;

  const accounts = status?.accounts ?? [];
  // Slice 3i: the owner's own domains count as known for the link dialog's lookalike check.
  const ownEmails = useRef<string[]>([]);
  ownEmails.current = accounts.map((a) => a.email);
  const cleanLinksOn = useRef(true);
  const [linkAsk, setLinkAsk] = useState<CleanLink | null>(null);
  // A view in the URL picks its scope: a merged role is All accounts, and a
  // folder of another account than the chosen one is that account. An
  // account chosen on this route wins until the route changes.
  const scopeChoice = (() => {
    const choice = chosen?.choice ?? null;
    if (routeView === null || accounts.length < 2 || chosen?.route === route.current.serial) return choice;
    if (routeView.kind === "role") return ALL_ACCOUNTS;
    const single = choice !== null && choice !== ALL_ACCOUNTS && accounts.some((a) => a.id === choice);
    const known = accounts.some((a) => a.id === routeView.accountId);
    return single && known ? routeView.accountId : choice;
  })();
  const chosenAccount =
    scopeChoice !== null && scopeChoice !== ALL_ACCOUNTS
      ? (accounts.find((a) => a.id === scopeChoice) ?? null)
      : null;
  const unified = accounts.length > 1 && chosenAccount === null;
  const account = unified ? null : (chosenAccount ?? accounts[0] ?? null);
  const scopeKey = status?.vaultReady ? (unified ? ALL_ACCOUNTS : (account?.id ?? null)) : null;
  const scoped = folderState !== null && folderState.key === scopeKey ? folderState : null;
  const folders = scoped?.folders ?? null;
  // The routed view while it exists in the scope, else the inbox (or the
  // merged Inbox). A folder is trusted while the scope's folders load.
  const view: MailView = (() => {
    const exists = (v: MailView) => {
      if (v.kind === "role") return unified;
      if (folders === null) return unified ? accounts.some((a) => a.id === v.accountId) : v.accountId === account?.id;
      return folders.some((f) => f.accountId === v.accountId && f.path === v.path && f.selectable);
    };
    if (routeView !== null && exists(routeView)) return routeView;
    if (unified || account === null) return { kind: "role", role: "inbox" };
    return { kind: "folder", accountId: account.id, path: inboxPath(folders) ?? DEFAULT_FOLDER_PATH };
  })();
  const currentViewKey = viewKey(view);
  /** Split Inbox: tabs sit over an Inbox only; the routed tab counts while its view is the one shown. */
  const inboxShown = isInboxView(view, folders);
  const routeTab = inboxShown && routeView !== null && sameView(routeView, view) ? route.current.tab : null;
  const searchAccount = unified ? null : (account?.id ?? null);

  // Latest values for callbacks that outlive a render (realtime, async results).
  const latest = useRef({
    scopeKey,
    searchAccount,
    unified,
    view,
    tab: routeTab,
    inbox: inboxShown,
    folders,
    list,
    search,
    reading,
    selection,
    subPath,
    unsubscribe: null as { messageId: string; info: UnsubscribeInfoView } | null,
  });
  latest.current = { ...latest.current, scopeKey, searchAccount, unified, view, tab: routeTab, inbox: inboxShown, folders, list, search, reading, selection, subPath };
  /** Messages this page already marked opened, so message_open runs once each. */
  const opened = useRef(new Set<string>());
  /** The account of the conversation open in the reading pane. */
  const openAccount = useRef<string | null>(null);
  /** The conversation open in the reading pane (or opening), at once rather than after a render. */
  const openThreadId = useRef<string | null>(null);
  /**
   * A conversation the subPath links to. It stays wanted while the page settles
   * (status, then folders, may reset the view) and is dropped once the owner
   * picks something on the page.
   */
  const wantedLink = useRef<ThreadLink | null>(null);
  const requests = useRef({ list: 0, search: 0, thread: 0, folders: 0, details: 0, tabs: 0 });
  /** Slice 3h: indexAttachmentText, read by the page's own search. */
  const searchAttachments = useRef(false);
  /** Slice 3h: folders the owner set to one row per message (this device; folder_prefs_set keeps the server's copy). */
  const [ungrouped, setUngrouped] = useState<ReadonlySet<string>>(() => readUngrouped());
  const ungroupedRef = useRef(ungrouped);
  ungroupedRef.current = ungrouped;
  const isGrouped = useCallback((forView: MailView) => !ungroupedRef.current.has(groupingKey(forView)), []);
  const pendingRef = useRef(false);
  /**
   * The page's own last undoable action (spec resolution 4): `z` undoes
   * this id only, so another window's action is never undone from here.
   */
  const lastUndo = useRef<{ id: string; moving: boolean } | null>(null);
  /** The undo result waiting for the reverse moves to show in the lists. */
  const movingBack = useRef<{ text: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  /**
   * Slice 3i (part B resolution 6): conversations the page advanced away from
   * after a removing action, by undo id, so an undo (`z` or a toast's own
   * Undo) can reopen them. `advancedTo` is what opened instead (null: none).
   */
  const reopenByUndo = useRef(new Map<string, { threadId: string; accountId: string | null; advancedTo: string | null }>());
  /** An undo is waiting for its conversation's row to come back; any open or close meanwhile cancels it. */
  const pendingReopen = useRef<{ threadId: string; accountId: string | null; openNow: string | null; until: number } | null>(null);
  /** Stars being changed by the owner: a list refresh meanwhile keeps these values. */
  const flagIntents = useRef(new Map<string, boolean>());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusLoaded = useRef(false);
  /** The quick filters per view while the page is open (slice 3e); a reload clears them. */
  const filtersRef = useRef(new Map<string, ListFilter>());
  const [, setFilterVersion] = useState(0);

  /** A failed first load replaces the page; a failed refresh keeps the mailbox and toasts. */
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await rpc.call("status_get", null));
      statusLoaded.current = true;
      setStatusError(null);
    } catch (error) {
      if (statusLoaded.current) toast.error(tx("Could not refresh mail status: {p1}", { p1: messageOf(error) }));
      else setStatusError(messageOf(error));
    }
  }, [rpc]);

  /**
   * "reset" and "more" fetch one page; "refresh" re-fetches from the top, page
   * after page, until it has at least as many threads as are on screen.
   */
  const loadList = useCallback(
    async (forView: MailView, mode: "reset" | "refresh" | "more") => {
      if (!isGrouped(forView)) return loadMessages(forView, mode);
      const token = ++requests.current.list;
      const current = latest.current.list;
      const wanted = mode === "refresh" ? Math.max(current.threads.length, PAGE_SIZE) : PAGE_SIZE;
      setList((prev) =>
        mode === "reset"
          ? { ...EMPTY_LIST, loading: true }
          : mode === "more"
            ? { ...prev, loadingMore: true }
            : prev,
      );
      try {
        const threads: ThreadListState["threads"] = [];
        let cursor = mode === "more" ? current.nextCursor : null;
        do {
          const limit = Math.min(wanted - threads.length, MAX_PAGE);
          const flags = filtersRef.current.get(viewKey(forView)) ?? NO_FILTER;
          const keep = openThreadId.current;
          const filter = filterActive(flags) ? { ...flags, ...(keep !== null ? { keep } : {}) } : undefined;
          // Split Inbox: a tab the server no longer knows lists the whole Inbox.
          const tabId = latest.current.tab;
          const page = await rpc.call("threads_list", {
            scope: scopeOf(forView),
            cursor,
            limit,
            ...(filter !== undefined ? { filter } : {}),
            ...(tabId !== null ? { tabId } : {}),
          });
          if (token !== requests.current.list) return;
          threads.push(...page.threads);
          cursor = page.nextCursor;
        } while (cursor !== null && threads.length < wanted);
        const shown = threads.map((t) => {
          const intent = flagIntents.current.get(t.id);
          return intent === undefined ? t : { ...t, flagged: intent };
        });
        setList((prev) => ({
          threads: mode === "more" ? [...prev.threads, ...shown] : shown,
          nextCursor: cursor,
          loading: false,
          loadingMore: false,
          error: null,
        }));
        if (mode === "refresh") {
          // Conversations that left the list leave the selection too.
          const ids = new Set(threads.map((t) => t.id));
          setSelection((prev) =>
            [...prev].every((id) => ids.has(id)) ? prev : new Set([...prev].filter((id) => ids.has(id))),
          );
        }
      } catch (error) {
        if (token !== requests.current.list) return;
        setList((prev) => ({ ...prev, loading: false, loadingMore: false, error: messageOf(error) }));
      }
    },
    [rpc],
  );

  /**
   * Split Inbox: the tabs and their unread counts for the Inbox shown. A
   * failed load keeps the row as it was; the list reports a store that fails.
   */
  const [tabState, setTabState] = useState<{ key: string; tabs: InboxTabView[]; inboxUnread: number } | null>(null);
  const loadTabs = useCallback(async () => {
    const { scopeKey: key, view: forView, inbox } = latest.current;
    if (key === null || !inbox) return;
    const token = ++requests.current.tabs;
    try {
      const result = await rpc.call("inbox_tabs_list", { scope: scopeOf(forView) });
      if (token === requests.current.tabs) setTabState({ key: viewKey(forView), tabs: result.tabs, inboxUnread: result.inboxUnread });
    } catch {
      // Kept as it was.
    }
  }, [rpc]);

  /** Slice 3h: a folder that is not grouped by conversation lists its messages (messages_list). */
  const loadMessages = useCallback(
    async (forView: MailView, mode: "reset" | "refresh" | "more") => {
      const token = ++requests.current.list;
      const current = latest.current.list;
      const shownBefore = current.messages ?? [];
      const wanted = mode === "refresh" ? Math.max(shownBefore.length, PAGE_SIZE) : PAGE_SIZE;
      setList((prev) =>
        mode === "reset" ? { ...EMPTY_LIST, messages: [], loading: true } : mode === "more" ? { ...prev, loadingMore: true } : prev,
      );
      try {
        const messages: NonNullable<ThreadListState["messages"]> = [];
        let cursor = mode === "more" ? current.nextCursor : null;
        do {
          const flags = filtersRef.current.get(viewKey(forView)) ?? NO_FILTER;
          const page = await rpc.call("messages_list", {
            scope: scopeOf(forView),
            cursor,
            limit: Math.min(wanted - messages.length, MAX_PAGE),
            ...(filterActive(flags) ? { filter: flags } : {}),
          });
          if (token !== requests.current.list) return;
          messages.push(...page.messages);
          cursor = page.nextCursor;
        } while (cursor !== null && messages.length < wanted);
        setList((prev) => ({
          threads: [],
          messages: mode === "more" ? [...(prev.messages ?? []), ...messages] : messages,
          nextCursor: cursor,
          loading: false,
          loadingMore: false,
          error: null,
        }));
      } catch (error) {
        if (token !== requests.current.list) return;
        setList((prev) => ({ ...prev, messages: prev.messages ?? [], loading: false, loadingMore: false, error: messageOf(error) }));
      }
    },
    [rpc],
  );

  /**
   * A failed load keeps the folders already on screen (or none), says why in
   * the rail and toasts once until a load succeeds; the list still shows the inbox.
   */
  const loadFolders = useCallback(
    async (key: string) => {
      const token = ++requests.current.folders;
      try {
        const { folders: next, roles } = await rpc.call("folders_list", {
          accountId: key === ALL_ACCOUNTS ? null : key,
        });
        if (token !== requests.current.folders) return;
        setFolderState({ key, folders: next, roles, error: null });
      } catch (error) {
        if (token !== requests.current.folders) return;
        const text = messageOf(error);
        setFolderState((prev) => {
          const same = prev !== null && prev.key === key;
          if (!same || prev.error === null) toast.error(tx("Could not load folders: {text}", { text }));
          return {
            key,
            folders: same ? prev.folders : [],
            roles: same ? prev.roles : [],
            error: text,
          };
        });
      }
    },
    [rpc],
  );

  const runSearch = useCallback(
    async (query: string, forAccount: string | null) => {
      const token = ++requests.current.search;
      if (latest.current.search.query !== query) setSelection(NO_SELECTION);
      if (query === "") {
        setSearch(NO_SEARCH);
        return;
      }
      setSearch((prev) => ({
        query,
        hits: prev.query === query ? prev.hits : [],
        loading: true,
        error: null,
      }));
      try {
        // Slice 3h: only this page's own search reads attachment text, and only with the setting on.
        const page = await rpc.call("search", {
          query,
          accountId: forAccount,
          limit: SEARCH_LIMIT,
          ...(searchAttachments.current ? { attachments: true } : {}),
        });
        if (token !== requests.current.search) return;
        setSearch({
          query,
          hits: page.hits,
          loading: false,
          error: null,
          notes: page.notes ?? [],
          attachmentMatches: page.attachmentMatches ?? [],
          nextCursor: page.nextCursor ?? null,
        });
      } catch (error) {
        if (token !== requests.current.search) return;
        setSearch({ query, hits: [], loading: false, error: messageOf(error) });
      }
    },
    [rpc],
  );

  /** Slice 3h: the next page of the search shown. */
  const searchMore = useCallback(async () => {
    const current = latest.current.search;
    const cursor = current.nextCursor ?? null;
    if (current.query === "" || cursor === null || current.loadingMore === true) return;
    const token = requests.current.search;
    setSearch((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await rpc.call("search", {
        query: current.query,
        accountId: latest.current.searchAccount,
        limit: SEARCH_LIMIT,
        cursor,
        ...(searchAttachments.current ? { attachments: true } : {}),
      });
      if (token !== requests.current.search) return;
      setSearch((prev) => ({
        ...prev,
        hits: [...prev.hits, ...page.hits.filter((hit) => !prev.hits.some((h) => h.id === hit.id))],
        attachmentMatches: [...(prev.attachmentMatches ?? []), ...(page.attachmentMatches ?? [])],
        nextCursor: page.nextCursor ?? null,
        loadingMore: false,
      }));
    } catch (error) {
      if (token !== requests.current.search) return;
      setSearch((prev) => ({ ...prev, loadingMore: false }));
      toast.error(tx("Could not load more results: {p1}", { p1: messageOf(error) }));
    }
  }, [rpc]);

  const loadBody = useCallback(
    async (messageId: string) => {
      setReading((prev) => ({ ...prev, bodies: { ...prev.bodies, [messageId]: { status: "loading" } } }));
      let state: BodyState;
      try {
        state = { status: "ready", body: await rpc.call("message_body", { messageId }) };
      } catch (error) {
        state = { status: "error", error: messageOf(error) };
      }
      setReading((prev) =>
        prev.bodies[messageId] === undefined
          ? prev
          : { ...prev, bodies: { ...prev.bodies, [messageId]: state } },
      );
    },
    [rpc],
  );

  /**
   * Marks unread messages read, each once per page session; only for
   * owner-opened mail. Resolves with the first failure's text, or null. A failed
   * message can be marked again later.
   */
  const markOpened = useCallback(
    async (messages: readonly MessageHeader[]): Promise<string | null> => {
      const unread = messages.filter((m) => !m.isRead && !opened.current.has(m.id));
      for (const message of unread) opened.current.add(message.id);
      const failures = await Promise.all(
        unread.map((message) =>
          rpc.call("message_open", { messageId: message.id }).then(
            () => null,
            (error: unknown) => {
              opened.current.delete(message.id);
              return messageOf(error);
            },
          ),
        ),
      );
      return failures.find((failure) => failure !== null) ?? null;
    },
    [rpc],
  );

  /** Expands a message and fetches its body once (again after an error). */
  const expandMessage = useCallback(
    (message: MessageHeader) => {
      setReading((prev) => ({ ...prev, expandedIds: new Set(prev.expandedIds).add(message.id) }));
      const body = latest.current.reading.bodies[message.id];
      if (body === undefined || body.status === "error") void loadBody(message.id);
    },
    [loadBody],
  );

  /** The owner expanded one message: show it and mark it read if it still is unread. */
  const openMessage = useCallback(
    (message: MessageHeader) => {
      expandMessage(message);
      void markOpened([message]).then((failure) => {
        if (failure !== null) toast.error(tx("Could not mark the message read: {failure}", { failure }));
      });
    },
    [expandMessage, markOpened],
  );

  /**
   * Loads a conversation; on first open, expands `focusId` or the newest message
   * and marks every unread message of it read (a mail client shows a conversation
   * unread while any message in it is). A refresh (`open === null`) marks nothing.
   */
  const loadThread = useCallback(
    async (threadId: string, open: { focusId: string | null } | null) => {
      const token = ++requests.current.thread;
      try {
        const detail = await rpc.call("thread_get", { threadId, folder: folderIn(latest.current, openAccount.current) });
        if (token !== requests.current.thread) return;
        setReading((prev) => ({ ...prev, detail, loading: false, error: null }));
        if (open !== null) {
          const focus =
            detail.messages.find((m) => m.id === open.focusId) ?? detail.messages.at(-1);
          if (focus !== undefined) expandMessage(focus);
          // The expanded message first, then the rest; one toast if any fails.
          const ordered =
            focus === undefined
              ? detail.messages
              : [focus, ...detail.messages.filter((m) => m !== focus)];
          void markOpened(ordered).then((failure) => {
            if (failure !== null) toast.error(tx("Could not mark the conversation read: {failure}", { failure }));
          });
        }
      } catch (error) {
        if (token !== requests.current.thread) return;
        if (open === null) {
          // A refresh keeps what is on screen, unless the conversation is gone
          // (its messages were deleted on the server).
          if ((error as { code?: unknown } | null)?.code === "not_found") {
            openThreadId.current = null;
            setReading(NO_READING);
          }
          return;
        }
        setReading((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
      }
    },
    [expandMessage, markOpened, rpc],
  );

  const selectThread = useCallback(
    (threadId: string, messageId: string | null, accountId: string) => {
      // A reply docked under another conversation closes (it saves itself).
      setComposer((prev) => (prev !== null && prev.dockThreadId !== null && prev.dockThreadId !== threadId ? null : prev));
      openAccount.current = accountId;
      openThreadId.current = threadId;
      setReading({ ...NO_READING, threadId, loading: true });
      void loadThread(threadId, { focusId: messageId });
    },
    [loadThread],
  );

  const closeThread = useCallback(() => {
    setComposer((prev) => (prev !== null && prev.dockThreadId !== null ? null : prev));
    requests.current.thread++;
    openThreadId.current = null;
    wantedLink.current = null;
    setReading(NO_READING);
  }, []);

  /** Opens the conversation the subPath names, unless it is already open. */
  const openLinked = useCallback(
    (link: ThreadLink) => {
      wantedLink.current = link;
      if (latest.current.scopeKey === null) return; // the view reset below opens it
      if (openThreadId.current === link.threadId && openAccount.current === link.accountId) return;
      selectThread(link.threadId, null, link.accountId);
    },
    [selectThread],
  );

  useEffect(() => {
    const link = parseThreadSubPath(subPath);
    if (link !== null) openLinked(link);
  }, [subPath, openLinked]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // A new scope (account or All accounts) loads its folders and re-runs the search for it.
  useEffect(() => {
    if (scopeKey === null) return;
    void loadFolders(scopeKey);
    const query = latest.current.search.query;
    if (query !== "") void runSearch(query, latest.current.searchAccount);
  }, [scopeKey, loadFolders, runSearch]);

  // A new view starts from its first page with nothing open or selected, and
  // a view change within the scope (back or forward too) ends any search.
  // A linked conversation opens again over the reset.
  const resetScope = useRef(scopeKey);
  useEffect(() => {
    const sameScope = resetScope.current === scopeKey;
    resetScope.current = scopeKey;
    if (sameScope && scopeKey !== null && latest.current.search.query !== "") {
      void runSearch("", latest.current.searchAccount);
    }
    requests.current.thread++;
    openThreadId.current = null;
    setReading(NO_READING);
    setSelection(NO_SELECTION);
    if (scopeKey === null) {
      setList(EMPTY_LIST);
      return;
    }
    void loadList(latest.current.view, "reset");
    void loadTabs();
    const link = wantedLink.current;
    if (link !== null) selectThread(link.threadId, null, link.accountId);
  }, [scopeKey, currentViewKey, routeTab, inboxShown, loadList, loadTabs, runSearch, selectThread]);

  useEffect(
    () => () => {
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
    },
    [],
  );

  const stopSyncing = useCallback(() => {
    if (syncTimer.current !== null) clearTimeout(syncTimer.current);
    syncTimer.current = null;
    setSyncing(false);
  }, []);

  /** After a change: the list, the folders' counts and any search, for the view still shown. */
  const refreshAfterChange = useCallback(() => {
    const { scopeKey: key, view: current, search: currentSearch, searchAccount: forAccount } = latest.current;
    if (key === null) return;
    void loadList(current, "refresh");
    void loadFolders(key);
    void loadTabs();
    if (currentSearch.query !== "") void runSearch(currentSearch.query, forAccount);
  }, [loadFolders, loadList, loadTabs, runSearch]);

  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, (payloads) => {
    void loadStatus();
    const waiting = movingBack.current;
    if (waiting !== null) {
      movingBack.current = null;
      clearTimeout(waiting.timer);
      toast(waiting.text, { id: UNDO_TOAST_ID });
    }
    const { scopeKey: key, unified: all, reading: currentReading } = latest.current;
    if (key === null) return;
    const touched = payloads.some((payload) => {
      const changed = changedAccount(payload);
      return changed === null || all || changed === key;
    });
    if (!touched) return;
    stopSyncing();
    refreshAfterChange();
    setMailVersion((version) => version + 1);
    // A thread still opening loads fresh data anyway; refreshing it now would
    // supersede the open and drop which message to expand.
    if (currentReading.threadId !== null && !currentReading.loading) {
      void loadThread(currentReading.threadId, null);
    }
  });


  /**
   * A view goes into the subPath, so BB's back and forward and the sidebar
   * follow it; the change resets the list (the effect above). Choosing the
   * view already shown only ends any search.
   */
  const selectView = useCallback(
    (next: MailView) => {
      const { scopeKey: key, search: currentSearch, searchAccount: forAccount, view: current } = latest.current;
      if (key === null) return;
      wantedLink.current = null;
      if (currentSearch.query !== "") void runSearch("", forAccount);
      // From the Today or Tasks page, the view the page sits on opens too.
      if (
        !sameView(next, current) ||
        latest.current.tab !== null ||
        parsePageSubPath(latest.current.subPath) !== null ||
        parseSavedSearchSubPath(latest.current.subPath) !== null
      ) {
        navigate.toPluginPanel("mail", { subPath: viewSubPath(next) });
      }
    },
    [navigate, runSearch],
  );

  /** A new scope opens on its inbox: the routed view is left behind. */
  const selectAccount = useCallback(
    (choice: string) => {
      wantedLink.current = null;
      setChosen({ choice, route: route.current.serial });
      if (latest.current.subPath !== "") navigate.toPluginPanel("mail", { subPath: "" });
    },
    [navigate],
  );

  /** The messages of each conversation in the view (the open one's from the pane). */
  const collect = useCallback(
    async (threadIds: readonly string[], snapshot: ReadingState, ctx: ViewContext) => {
      const items: ActionItem[] = [];
      const failures = new Map<string, string>();
      const details = new Map<string, ThreadDetail>();
      const accountOf = (threadId: string) =>
        latest.current.list.threads.find((t) => t.id === threadId)?.accountId ??
        (snapshot.detail?.thread.id === threadId ? snapshot.detail.thread.accountId : null);
      await inPool(threadIds, COLLECT_CONCURRENCY, async (threadId) => {
        try {
          const detail =
            snapshot.detail !== null && snapshot.detail.thread.id === threadId
              ? snapshot.detail
              : await rpc.call("thread_get", { threadId, folder: folderIn(ctx, accountOf(threadId)) });
          details.set(threadId, detail);
        } catch (error) {
          failures.set(threadId, messageOf(error));
        }
      });
      // In the order the owner sees, so chunks and calls are predictable.
      for (const threadId of threadIds) {
        for (const message of details.get(threadId)?.messages ?? []) {
          if (inViewOf(ctx, message)) {
            items.push({ id: message.id, accountId: message.accountId, folder: message.folder, threadId });
          }
        }
      }
      return { items, failures, details };
    },
    [rpc],
  );

  /**
   * Sends `items` in calls of at most ACTION_CHUNK ids, one after another. A
   * refusal of the whole call (thrown) fails every conversation in it; a
   * group's error fails the conversations with messages in that group.
   * `shortfall` counts ids the server neither queued nor refused.
   */
  const sendAction = useCallback(
    async (
      items: readonly ActionItem[],
      action: MessageAction,
      ctx: ViewContext,
      destination?: string,
      /** One id for every chunk of the batch: the server keeps it as the undoable action. */
      undoId?: string,
    ) => {
      const failed = new Map<string, string>();
      const destinations = new Set<string>();
      let shortfall = 0;
      let undoable = false;
      const source = sourceOf(ctx.view);
      const fail = (item: ActionItem, error: string) => {
        if (!failed.has(item.threadId)) failed.set(item.threadId, error);
      };
      for (let start = 0; start < items.length; start += ACTION_CHUNK) {
        const chunk = items.slice(start, start + ACTION_CHUNK);
        try {
          const result = await rpc.call("message_action", {
            messageIds: chunk.map((item) => item.id),
            action,
            ...source,
            ...(destination !== undefined ? { destination } : {}),
            ...(undoId !== undefined ? { undoId } : {}),
          });
          const { groups } = result;
          if (result.undoable === true) undoable = true;
          if (groups.length === 0) {
            for (const item of chunk) fail(item, "Nothing was changed");
            continue;
          }
          let accounted = 0;
          for (const group of groups) {
            const members = chunk.filter(
              (item) => item.accountId === group.accountId && item.folder === group.folder,
            );
            if (group.error === null) {
              accounted += group.queued;
              if (group.destination !== null) destinations.add(group.destination);
              continue;
            }
            accounted += members.length;
            for (const item of members) fail(item, group.error);
          }
          shortfall += Math.max(0, chunk.length - accounted);
        } catch (error) {
          for (const item of chunk) fail(item, messageOf(error));
        }
      }
      return { failed, destinations, shortfall, undoable };
    },
    [rpc],
  );

  /**
   * Undoes the action recorded under `undoId` (the toast's own, or `z`'s
   * page-local last one). "Moving back…" stays until the next mail-changed
   * shows the reverse moves; then the result.
   */
  const undo = useCallback(
    async (undoId: string | null, moving: boolean) => {
      if (undoId === null) {
        toast(tx("Nothing to undo"), { id: UNDO_TOAST_ID });
        return;
      }
      try {
        const result = await rpc.call("action_undo", { undoId });
        // Failed copy groups stay undoable under the same id; anything else is spent.
        if (lastUndo.current?.id === undoId && result.failed === 0) lastUndo.current = null;
        const text = undoResultText(result);
        const reopen = reopenByUndo.current.get(undoId);
        reopenByUndo.current.delete(undoId);
        if (result.outcome === "done" && result.restored > 0 && reopen !== undefined) {
          // Only while the owner is still on what the action opened (or nothing).
          const openNow = openThreadId.current;
          if (openNow === reopen.advancedTo || openNow === null) {
            pendingReopen.current = { threadId: reopen.threadId, accountId: reopen.accountId, openNow, until: Date.now() + MOVING_BACK_MAX_MS };
          }
        }
        if (result.outcome === "done" && moving && result.restored > 0) {
          if (movingBack.current !== null) clearTimeout(movingBack.current.timer);
          toast(tx("Moving back\u2026"), { id: UNDO_TOAST_ID, duration: Number.POSITIVE_INFINITY });
          movingBack.current = {
            text,
            timer: setTimeout(() => {
              if (movingBack.current?.text !== text) return;
              movingBack.current = null;
              toast(text, { id: UNDO_TOAST_ID });
            }, MOVING_BACK_MAX_MS),
          };
        } else {
          toast(text, { id: UNDO_TOAST_ID });
        }
        if (result.outcome !== "nothing") refreshAfterChange();
      } catch (error) {
        toast.error(messageOf(error), { id: UNDO_TOAST_ID });
      }
    },
    [refreshAfterChange, rpc],
  );
  useEffect(
    () => () => {
      if (movingBack.current !== null) clearTimeout(movingBack.current.timer);
    },
    [],
  );

  /** After an undoable action: the page's last id, and the toast with Undo when one is due. */
  const recordUndo = useCallback(
    (undoId: string, action: UndoAction, count: number, destinationName: string | null, toastIt: boolean) => {
      const moving = movesMail(action);
      lastUndo.current = { id: undoId, moving };
      if (!toastIt) return;
      toast(undoToastText(action, count, destinationName), {
        id: UNDO_TOAST_ID,
        duration: UNDO_TOAST_MS,
        action: { label: tx("Undo"), onClick: () => void undo(undoId, moving) },
      });
    },
    [undo],
  );

  /**
   * Slice 3i (part B B5): the open conversation is done. The next one opens
   * (`then`, from the page) only while it is still the one the action started
   * on; otherwise, or with nothing to open, it closes as before. An advance is
   * recorded under the undo id so an undo can reopen it.
   */
  const advanceOrClose = useCallback(
    (open: string, startedOn: string | null, then: (() => void) | null | undefined, undoId: string | null) => {
      if (then == null || open !== startedOn) {
        closeThread();
        return;
      }
      const accountId = openAccount.current;
      then();
      if (undoId !== null) {
        setBounded(reopenByUndo.current, undoId, { threadId: open, accountId, advancedTo: openThreadId.current }, REOPEN_BY_UNDO_MAX);
      }
    },
    [closeThread],
  );

  // Slice 3i (part B resolution 6): an undone conversation reopens once its
  // row is back in the list, within MOVING_BACK_MAX_MS, unless the owner
  // opened or closed a conversation meanwhile.
  useEffect(() => {
    const want = pendingReopen.current;
    if (want === null) return;
    if (Date.now() > want.until || openThreadId.current !== want.openNow) {
      pendingReopen.current = null;
      return;
    }
    const row = list.threads.find((t) => t.id === want.threadId);
    if (row === undefined) return;
    pendingReopen.current = null;
    selectThread(row.id, null, want.accountId ?? row.accountId);
  }, [list.threads, selectThread]);

  /**
   * An action on conversations' messages in the view: the selection bar, the
   * reading pane toolbar and the hotkeys. Failed conversations stay selected;
   * one toast per distinct error.
   */
  const threadsAction = useCallback(
    async (threadIds: string[], action: MessageAction, destination?: string, then?: (() => void) | null) => {
      if (threadIds.length === 0 || pendingRef.current) return;
      pendingRef.current = true;
      setActionPending(true);
      const snapshot = latest.current.reading;
      // The view at the start: a folder switch meanwhile must not retarget the action.
      const ctx: ViewContext = { view: latest.current.view, folders: latest.current.folders };
      const moving = isRoleMoveAction(action) || action === "move";
      // Mark unread goes back to the list first, so nothing marks the messages read again.
      if (action === "mark_unread" && snapshot.threadId !== null && threadIds.includes(snapshot.threadId)) {
        closeThread();
      }
      try {
        const collected = await collect(threadIds, snapshot, ctx);
        const items = flagChoice(collected.items, collected.details, action, ctx);
        const undoId = crypto.randomUUID();
        const { failed, destinations, shortfall, undoable } = await sendAction(items, action, ctx, destination, undoId);
        for (const [threadId, error] of collected.failures) failed.set(threadId, error);
        for (const error of new Set(failed.values())) toast.error(error);
        // Nothing of these in the view (or nothing to flag): not done, so they stay selected.
        const empty = threadIds.filter((id) => !failed.has(id) && !items.some((item) => item.threadId === id));
        if (empty.length > 0) {
          toast.error(`${plural(empty.length, "conversation", "conversations")} had nothing to change here`);
        }
        if (shortfall > 0) toast.error(`${plural(shortfall, "message", "messages")} had nothing to change here`);
        const done = new Set(threadIds.filter((id) => !failed.has(id) && !empty.includes(id)));
        if (undoable && done.size > 0) {
          // A move always toasts; a flag or read change only for two or more conversations.
          const names = [...destinations].join(", ");
          recordUndo(undoId, action, done.size, names === "" ? null : names, moving || done.size >= 2);
        } else if (moving && done.size > 0 && destinations.size > 0) {
          toast.success(tx("Moved to {p1}", { p1: [...destinations].join(", ") }));
        }
        if (action === "mark_unread") {
          // A later open marks them read again.
          for (const item of items) if (done.has(item.threadId)) opened.current.delete(item.id);
        }
        setSelection((prev) => {
          if (![...prev].some((id) => done.has(id))) return prev;
          return new Set([...prev].filter((id) => !done.has(id)));
        });
        const doneIds = new Set(items.filter((item) => done.has(item.threadId)).map((item) => item.id));
        if (moving) {
          setList((prev) => ({ ...prev, threads: prev.threads.filter((t) => !done.has(t.id)) }));
          const open = latest.current.reading.threadId;
          if (open !== null && done.has(open)) advanceOrClose(open, snapshot.threadId, then, undoable ? undoId : null);
        } else {
          const flagged = action === "flag" ? true : action === "unflag" ? false : null;
          setList((prev) => ({
            ...prev,
            threads: prev.threads.map((t) => {
              if (!done.has(t.id)) return t;
              if (flagged !== null) return { ...t, flagged };
              return { ...t, unreadCount: action === "mark_read" ? 0 : Math.max(t.unreadCount, 1) };
            }),
          }));
          setReading((prev) =>
            prev.detail === null
              ? prev
              : {
                  ...prev,
                  detail: {
                    ...prev.detail,
                    messages: prev.detail.messages.map((m) =>
                      !doneIds.has(m.id)
                        ? m
                        : flagged !== null
                          ? { ...m, isFlagged: flagged }
                          : { ...m, isRead: action === "mark_read" },
                    ),
                  },
                },
          );
        }
        if (done.size > 0) refreshAfterChange();
      } finally {
        pendingRef.current = false;
        setActionPending(false);
      }
    },
    [advanceOrClose, collect, recordUndo, refreshAfterChange, sendAction],
  );

  /** Sets a list row's star, and the open conversation's messages to match. */
  const setThreadFlagged = useCallback((threadId: string, flagged: boolean) => {
    setList((prev) => ({
      ...prev,
      threads: prev.threads.map((t) => (t.id === threadId ? { ...t, flagged } : t)),
    }));
  }, []);

  /**
   * The row star (and `s`): when any message of the conversation in the view is
   * flagged, unflag all of them; otherwise flag the newest one. The star
   * changes at once and goes back when the server refuses.
   */
  const toggleThreadFlag = useCallback(
    async (threadId: string) => {
      const { list: currentList, reading: snapshot } = latest.current;
      const flaggedBefore =
        currentList.threads.find((t) => t.id === threadId)?.flagged ??
        (snapshot.detail?.thread.id === threadId ? snapshot.detail.thread.flagged : null);
      if (flaggedBefore === null || flagIntents.current.has(threadId)) return;
      const ctx: ViewContext = { view: latest.current.view, folders: latest.current.folders };
      // While this runs, a list refresh keeps showing the new star.
      flagIntents.current.set(threadId, !flaggedBefore);
      setThreadFlagged(threadId, !flaggedBefore);
      try {
        const { items, failures, details } = await collect([threadId], snapshot, ctx);
        const failure = failures.get(threadId);
        if (failure !== undefined) throw new Error(failure);
        const action = flaggedBefore ? "unflag" : "flag";
        const targets = flagChoice(items, details, action, ctx);
        if (targets.length === 0) {
          setThreadFlagged(threadId, flaggedBefore);
          return;
        }
        const chosenIds = new Set(targets.map((item) => item.id));
        const undoId = crypto.randomUUID();
        const { failed, undoable } = await sendAction(targets, action, ctx, undefined, undoId);
        const error = failed.get(threadId);
        if (error !== undefined) throw new Error(error);
        // A single star shows no toast; `z` still undoes it.
        if (undoable) recordUndo(undoId, action, 1, null, false);
        setReading((prev) =>
          prev.detail === null || prev.detail.thread.id !== threadId
            ? prev
            : {
                ...prev,
                detail: {
                  ...prev.detail,
                  messages: prev.detail.messages.map((m) =>
                    chosenIds.has(m.id) ? { ...m, isFlagged: !flaggedBefore } : m,
                  ),
                },
              },
        );
      } catch (error) {
        setThreadFlagged(threadId, flaggedBefore);
        toast.error(messageOf(error));
      } finally {
        flagIntents.current.delete(threadId);
      }
    },
    [collect, recordUndo, sendAction, setThreadFlagged],
  );

  /** The star of one message in the reading pane: that message only, wherever its copy is. */
  const toggleMessageFlag = useCallback(
    async (message: MessageHeader) => {
      const next = !message.isFlagged;
      const setFlag = (value: boolean) =>
        setReading((prev) =>
          prev.detail === null
            ? prev
            : {
                ...prev,
                detail: {
                  ...prev.detail,
                  messages: prev.detail.messages.map((m) => (m.id === message.id ? { ...m, isFlagged: value } : m)),
                },
              },
        );
      setFlag(next);
      try {
        const undoId = crypto.randomUUID();
        const action = next ? "flag" : "unflag";
        const { groups, undoable } = await rpc.call("message_action", {
          messageIds: [message.id],
          action,
          folder: message.folder,
          undoId,
        });
        const refused = groups.find((g) => g.error !== null);
        if (refused !== undefined) throw new Error(refused.error!);
        if (undoable === true) recordUndo(undoId, action, 1, null, false);
      } catch (error) {
        setFlag(!next);
        toast.error(messageOf(error));
      }
    },
    [recordUndo, rpc],
  );

  /** "Show images" for one message: page state only, gone when the conversation closes. */
  const showImages = useCallback((messageId: string) => {
    setReading((prev) => ({ ...prev, remoteImageIds: new Set(prev.remoteImageIds).add(messageId) }));
  }, []);

  /** "Always show from …": the server remembers the sender; this page shows them now. */
  const alwaysShowImages = useCallback(
    async (message: MessageHeader) => {
      try {
        const { address } = await rpc.call("images_allow_sender", { messageId: message.id });
        setReading((prev) => ({
          ...prev,
          imageSenders: new Set(prev.imageSenders).add(address.trim().toLowerCase()),
        }));
      } catch (error) {
        toast.error(tx("Could not allow images: {p1}", { p1: messageOf(error) }));
      }
    },
    [rpc],
  );

  /** "Stop showing": the sender leaves the always-show list; open bodies load again without images. */
  const stopImages = useCallback(
    async (message: MessageHeader) => {
      const address = message.from.address.trim().toLowerCase();
      try {
        await rpc.call("images_disallow_sender", { accountId: message.accountId, address: message.from.address });
      } catch (error) {
        toast.error(tx("Could not stop showing images: {p1}", { p1: messageOf(error) }));
        return;
      }
      const { detail, bodies } = latest.current.reading;
      setReading((prev) => {
        const senders = new Set(prev.imageSenders);
        senders.delete(address);
        const remote = new Set(prev.remoteImageIds);
        for (const m of prev.detail?.messages ?? []) {
          if (m.from.address.trim().toLowerCase() === address) remote.delete(m.id);
        }
        return { ...prev, imageSenders: senders, remoteImageIds: remote };
      });
      for (const m of detail?.messages ?? []) {
        if (m.from.address.trim().toLowerCase() === address && bodies[m.id] !== undefined) void loadBody(m.id);
      }
    },
    [loadBody, rpc],
  );

  const openDetails = useCallback(
    async (message: MessageHeader) => {
      const token = ++requests.current.details;
      setDetails({ messageId: message.id, status: "loading" });
      try {
        const source = await rpc.call("message_source", { messageId: message.id });
        if (token !== requests.current.details) return;
        setDetails({ messageId: message.id, status: "ready", source });
      } catch (error) {
        if (token !== requests.current.details) return;
        setDetails({ messageId: message.id, status: "error", error: messageOf(error) });
      }
    },
    [rpc],
  );

  /** Slice 3i: a body fetched again in place (no loading state), after its sender check changed. */
  const refreshBody = useCallback(
    async (messageId: string) => {
      try {
        const body = await rpc.call("message_body", { messageId });
        setReading((prev) =>
          prev.bodies[messageId]?.status !== "ready" ? prev : { ...prev, bodies: { ...prev.bodies, [messageId]: { status: "ready", body } } },
        );
      } catch {
        // The body on screen stays; the next open fetches it again.
      }
    },
    [rpc],
  );

  /** Slice 3i: Details' Check again: the forced refresh, then the thread and Details again. */
  const checkSenderAgain = useCallback(
    async (messageId: string) => {
      await rpc.call("sender_check_refresh", { messageIds: [messageId], force: true });
      const threadId = latest.current.reading.threadId;
      if (threadId !== null) await loadThread(threadId, null);
      const message = latest.current.reading.detail?.messages.find((m) => m.id === messageId);
      if (message !== undefined) {
        void refreshBody(messageId);
        await openDetails(message);
      }
    },
    [loadThread, openDetails, refreshBody, rpc],
  );

  // Slice 3i (part B I3, I7): expanded messages whose sender check is
  // `unknown` (synced before 3i) are judged once the conversation has stayed
  // open briefly; each message once per page session, never stacked or
  // collapsed ones. A result that lands after the owner moved on is stored
  // and shown next time.
  const checkRequested = useRef(new Set<string>());
  useEffect(() => {
    const { threadId, detail, expandedIds } = reading;
    if (threadId === null || detail === null) return;
    const ids = detail.messages
      .filter((m) => expandedIds.has(m.id) && (m.senderCheck?.state ?? "unknown") === "unknown" && !checkRequested.current.has(m.id))
      .map((m) => m.id)
      .slice(0, SENDER_CHECK_BATCH);
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      if (latest.current.reading.threadId !== threadId) return;
      for (const id of ids) addBounded(checkRequested.current, id, SENDER_CHECK_REMEMBERED);
      rpc.call("sender_check_refresh", { messageIds: ids }).then(
        ({ refreshed }) => {
          if (refreshed === ids.length) {
            // Every row is judged now and never `unknown` again: nothing to remember.
            for (const id of ids) checkRequested.current.delete(id);
          }
          if (refreshed === 0 || latest.current.reading.threadId !== threadId) return;
          void loadThread(threadId, null);
          for (const id of ids) void refreshBody(id);
        },
        () => {
          // Stays unknown: images wait and Details offers Check again.
        },
      );
    }, SENDER_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loadThread, reading.detail, reading.expandedIds, reading.threadId, refreshBody, rpc]);

  const closeDetails = useCallback(() => {
    requests.current.details++;
    setDetails(null);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      return await experimental_copyToClipboard({ text });
    } catch {
      return false;
    }
  }, []);

  /**
   * A download: a one-time ticket, then BB's own save. When BB could not
   * start it (an older BB, or a URL it does not take), a fresh ticket goes
   * through a plain `<a download>` instead.
   */
  const download = useCallback(
    async (message: MessageHeader, attachment: AttachmentMeta | null) => {
      const request =
        attachment === null
          ? ({ kind: "eml", messageId: message.id } as const)
          : ({ kind: "attachment", messageId: message.id, partId: attachment.partId } as const);
      try {
        const ticket = await rpc.call("download_ticket", request);
        if ((await saveTicket(ticket)) === "started") return;
        anchorDownload(await rpc.call("download_ticket", request));
      } catch (error) {
        toast.error(tx("Could not download: {p1}", { p1: messageOf(error) }));
      }
    },
    [rpc],
  );

  const toggleMessage = useCallback(
    (messageId: string) => {
      const { detail, expandedIds } = latest.current.reading;
      if (expandedIds.has(messageId)) {
        setReading((prev) => {
          const next = new Set(prev.expandedIds);
          next.delete(messageId);
          return { ...prev, expandedIds: next };
        });
        return;
      }
      const message = detail?.messages.find((m) => m.id === messageId);
      if (message !== undefined) openMessage(message);
    },
    [openMessage],
  );

  const sync = useCallback(async () => {
    if (scopeKey === null) return;
    setSyncing(true);
    if (syncTimer.current !== null) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(stopSyncing, SYNC_INDICATOR_MS);
    try {
      const { started } = await rpc.call("sync_now", { accountId: searchAccount });
      if (!started) stopSyncing();
    } catch (error) {
      stopSyncing();
      toast.error(tx("Sync failed: {p1}", { p1: messageOf(error) }));
    }
  }, [rpc, scopeKey, searchAccount, stopSyncing]);

  const goToUrl = useCallback(
    (url: string) => {
      if (!navigate.openUrl(url)) toast.error(tx("This link cannot be opened here."));
    },
    [navigate],
  );
  /**
   * Slice 3i: the one choke point for every link Mail opens (part A
   * resolutions 9 and 10). core cleanLink refuses what is not http(s) or
   * mailto, cleans the URL when the setting is on, and asks first for text
   * that names another site, mixed alphabets or a lookalike of a domain the
   * owner writes to. PDF, alert and dev links pass no text.
   */
  const openLink = useCallback(
    (url: string, text: string | null = null) => {
      const likes = (latest.current.reading.detail?.messages ?? []).flatMap((m) =>
        (m.warnings ?? []).flatMap((w) => (w.kind === "lookalike" ? [w.like] : [])),
      );
      const own = ownEmails.current.map(addressDomain).filter((d): d is string => d !== null);
      const clean = cleanLink(url, text, { clean: cleanLinksOn.current, known: buildKnownDomains([...own, ...likes]) });
      if (clean === null) {
        toast.error(tx("This link cannot be opened here."));
        return;
      }
      if (clean.needsDialog) {
        setLinkAsk(clean);
        return;
      }
      goToUrl(clean.url);
    },
    [goToUrl],
  );

  // Preferred: a mail mention pill in the new-thread draft, resolved by the
  // mention provider at send time. useComposer() on a nav-panel page binds to
  // the route's draft; when that is not the new-thread draft, or insert
  // throws, the prompt carries the message's agent text instead, so the agent
  // gets the message even when agentTools is off.
  const handToAgent = useCallback(
    async (message: MessageHeader) => {
      if (composer.scope.kind === "new-thread") {
        try {
          composer.insert(
            // The chip label lands in the transcript: the redacted subject (spec resolution 4).
            { provider: "mail", id: message.id, label: subjectOrPlaceholder(message.agentSubject) },
            { at: "end" },
          );
          navigate.toCompose({ focusPrompt: true });
          return;
        } catch {
          // Fall through to the prompt.
        }
      }
      let text: string;
      try {
        ({ text } = await rpc.call("message_agent_text", { messageId: message.id }));
      } catch (error) {
        toast.error(tx("Could not hand the message to an agent: {p1}", { p1: messageOf(error) }));
        return;
      }
      navigate.toCompose({ initialPrompt: handToAgentPrompt(text), focusPrompt: true });
    },
    [composer, navigate, rpc],
  );

  const testAccount = useCallback(
    async (input: NewAccountInput) => {
      try {
        return await rpc.call("accounts_test", input);
      } catch (error) {
        return { ok: false, reason: messageOf(error) };
      }
    },
    [rpc],
  );

  /** The banner's retry: one sign-in with the saved password, then the status again. */
  const retrySignIn = useCallback(
    async (accountId: string) => {
      try {
        const { result } = await rpc.call("accounts_retry_sign_in", { accountId });
        if (result === "resumed") toast.success(tx("The server accepted the saved password. Sync is on again."));
        else if (result === "refused") {
          toast.error(tx("The server refused the saved password again. Try later or update the app password."));
        } else if (result === "unreachable") toast.error(tx("The mail server could not be reached. Try again later."));
        else if (result === "sign_in_needed") toast.error(tx("Google no longer accepts this sign-in. Sign in to Google again."));
        else toast.error(tx("The saved password cannot be read. Enter it again."));
      } catch (error) {
        toast.error(tx("Could not sign in: {p1}", { p1: messageOf(error) }));
      }
      await loadStatus();
    },
    [loadStatus, rpc],
  );

  /**
   * Sign in with Google from the account form: the server opens its listener,
   * Google opens in the browser, and the status is asked once a second until
   * the account is saved, the sign-in fails or the form goes away.
   */
  const googleSignIn = useCallback(
    async (email: string | null, signal: AbortSignal, extraScopes?: (typeof GOOGLE_EXTRA_SCOPES)[number][]): Promise<GoogleSignInOutcome> => {
      const { flowId, url } = await rpc.call("google_sign_in_start", extraScopes === undefined ? { email } : { email, extraScopes });
      if (!navigate.openUrl(url)) return { ok: false, message: tx("This link cannot be opened here.") };
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, GOOGLE_SIGN_IN_POLL_MS));
        if (signal.aborted) return { ok: false, message: "" };
        const flow = await rpc.call("google_sign_in_status", { flowId });
        if (flow.state === "pending") continue;
        if (flow.state === "failed") return { ok: false, message: googleSignInFailureText(flow.reason) };
        selectAccount(flow.accountId);
        setAccountForm(null);
        await loadStatus();
        return { ok: true };
      }
    },
    [loadStatus, navigate, rpc, selectAccount],
  );

  const saveAccount = useCallback(
    async (input: NewAccountInput) => {
      const saved = await rpc.call("accounts_add", input);
      selectAccount(saved.id);
      setAccountForm(null);
      await loadStatus();
    },
    [loadStatus, rpc, selectAccount],
  );


  // ---- Compose and send (slice 3b) ----

  const openComposer = useCallback(
    (draft: DraftView, warning: ComposeWarningKind, dropped: string[], dockThreadId: string | null, initialOwn?: readonly string[]) => {
      setComposer({ draft, warning, dropped, dockThreadId, ...(initialOwn !== undefined ? { initialOwn } : {}) });
    },
    [],
  );

  /** A draft the subPath names (an agent's card after Open in Mail, or its thread row): opened once per link. */
  const openedDraftLink = useRef<string | null>(null);
  useEffect(() => {
    const draftId = parseDraftSubPath(subPath);
    if (draftId === null || openedDraftLink.current === draftId) {
      if (draftId === null) openedDraftLink.current = null;
      return;
    }
    openedDraftLink.current = draftId;
    rpc.call("compose_open", { draftId }).then(
      ({ draft, warning }) => openComposer(draft, warning, [], null),
      (error: unknown) => toast.error(tx("Could not open the draft: {p1}", { p1: messageOf(error) })),
    );
  }, [openComposer, rpc, subPath]);

  /** A new message from the account viewed (All accounts: the first account). */
  const compose = useCallback(async () => {
    const from = account?.id ?? accounts[0]?.id;
    if (from === undefined) return;
    try {
      const { draftId } = await rpc.call("compose_new", { accountId: from });
      const { draft, warning } = await rpc.call("compose_open", { draftId });
      openComposer(draft, warning, [], null);
    } catch (error) {
      toast.error(tx("Could not start a message: {p1}", { p1: messageOf(error) }));
    }
  }, [account, accounts, openComposer, rpc]);

  const reply = useCallback(
    async (kind: ComposeKind, message: MessageHeader) => {
      try {
        // Quick quote: with text selected inside this message, a reply quotes only that.
        const quote = kind === "forward" || typeof document === "undefined" ? null : selectedQuote(document, message.id);
        const prepared = await rpc.call("compose_prepare", { kind, messageId: message.id, ...(quote !== null ? { quote } : {}) });
        // Said aloud: the rest of the original is not in this reply.
        if (quote !== null) toast(tx("Replying with only the selected text quoted"));
        const { draft } = await rpc.call("compose_open", { draftId: prepared.draftId });
        openComposer(draft, prepared.warning, prepared.dropped, latest.current.reading.threadId);
      } catch (error) {
        toast.error(tx("Could not start the {p1}: {p2}", { p1: kind === "forward" ? "forward" : "reply", p2: messageOf(error) }));
      }
    },
    [openComposer, rpc],
  );

  /** Our draft by id, or a synced Drafts message continued by its message id. */
  const editDraft = useCallback(
    async (message: MessageHeader) => {
      try {
        const { draft, warning } = await rpc.call(
          "compose_open",
          message.draftId !== null ? { draftId: message.draftId } : { draftMessageId: message.id },
        );
        openComposer(draft, warning, [], null);
      } catch (error) {
        toast.error(tx("Could not open the draft: {p1}", { p1: messageOf(error) }));
      }
    },
    [openComposer, rpc],
  );

  /** Enter or o on a Drafts row: the conversation's newest draft in the folder. */
  const editDraftThread = useCallback(
    async (threadId: string, accountId: string) => {
      const ctx: ViewContext = { view: latest.current.view, folders: latest.current.folders };
      try {
        const detail = await rpc.call("thread_get", { threadId, folder: folderIn(ctx, accountId) });
        const message = detail.messages.filter((m) => inViewOf(ctx, m)).at(-1) ?? detail.messages.at(-1);
        if (message !== undefined) await editDraft(message);
      } catch (error) {
        toast.error(tx("Could not open the draft: {p1}", { p1: messageOf(error) }));
      }
    },
    [editDraft, rpc],
  );

  const composerPorts = useMemo<ComposerPorts>(
    () => ({
      save: (input) => rpc.call("compose_save", input),
      send: (input) => rpc.call("compose_send", input),
      pgpCheck: (from, recipients) => rpc.call("pgp_check", { from, recipients }),
      applyTemplate: (input) => rpc.call("template_apply", input),
      discard: async (draftId) => {
        await rpc.call("compose_discard", { draftId });
      },
      upload: {
        begin: (input) => rpc.call("compose_attachment_begin", input),
        chunk: (input) => rpc.call("compose_attachment_chunk", input),
        finish: (input) => rpc.call("compose_attachment_finish", input),
      },
      removeAttachment: async (draftId, attachmentId) => {
        await rpc.call("compose_attachment_remove", { draftId, attachmentId });
      },
      suggest: async (prefix) => (await rpc.call("recipients_suggest", { prefix })).suggestions,
      reload: async (draftId) => (await rpc.call("compose_open", { draftId })).draft,
      check: (input) => rpc.call("compose_check", input),
    }),
    [rpc],
  );

  const loadOutbox = useCallback(async (): Promise<OutboxRow[] | null> => {
    try {
      const { rows } = await rpc.call("outbox_list", { accountId: null });
      setOutbox(rows);
      return rows;
    } catch {
      return null;
    }
  }, [rpc]);

  /** Undo (or Edit): the send is removed and its draft comes back into the composer. */
  const undoSend = useCallback(
    async (outboxId: string, tooLate = "Too late to undo") => {
      const toastId = sendToastId(outboxId);
      try {
        const { cancelled, draftId } = await rpc.call("outbox_cancel", { id: outboxId });
        if (!cancelled) {
          toast.error(tooLate, { id: toastId });
          return;
        }
        toast.dismiss(toastId);
        void loadOutbox();
        if (draftId !== null) {
          const { draft, warning } = await rpc.call("compose_open", { draftId });
          openComposer(draft, warning, [], null);
        }
      } catch (error) {
        toast.error(tx("Could not undo: {p1}", { p1: messageOf(error) }), { id: toastId });
      }
    },
    [loadOutbox, openComposer, rpc],
  );

  /** "Sending in N s · Undo" for a queued send, on every queued event. */
  const showUndo = useCallback(
    (outboxId: string, sendAfter: string | null, origin: OutboxRow["origin"] = "owner", purpose: OutboxRow["purpose"] = null) => {
      const due = sendAfter === null ? NaN : Date.parse(sendAfter);
      const left = Number.isNaN(due) ? UNDO_WINDOW_MS : Math.max(0, due - Date.now());
      // "Send later" (slice 3l): no countdown; the row waits in the Outbox, where Edit cancels it.
      if (left > SCHEDULED_TOAST_MS) {
        toast(tx("Send scheduled for {when}", { when: formatUntil(sendAfter) }), {
          id: sendToastId(outboxId),
          action: { label: tx("Undo"), onClick: () => void undoSend(outboxId) },
        });
        return;
      }
      const label =
        purpose === "unsubscribe"
          ? tx("Unsubscribe email queued \u00b7 ")
          : purpose === "invite_reply"
            ? tx("Answer to the invitation \u00b7 ")
            : origin === "agent"
              ? tx("Agent message \u00b7 ")
              : "";
      toast(`${label}Sending in ${Math.max(1, Math.ceil(left / 1000))} s`, {
        id: sendToastId(outboxId),
        duration: left + 2_000,
        action: { label: tx("Undo"), onClick: () => void undoSend(outboxId) },
      });
    },
    [undoSend],
  );

  /** Pending Undo windows survive a page reload (and a restart publishes nothing). */
  const outboxChecked = useRef(false);
  useEffect(() => {
    if (!status?.vaultReady || outboxChecked.current) return;
    outboxChecked.current = true;
    void loadOutbox().then((rows) => {
      // A scheduled send says so once, when it is queued; not again on every reload.
      for (const row of rows ?? []) {
        if (row.state === "queued" && row.scheduled !== true) showUndo(row.id, row.sendAfter, row.origin, row.purpose);
      }
    });
  }, [loadOutbox, showUndo, status?.vaultReady]);

  useDebouncedRealtime(OUTBOX_CHANGED_CHANNEL, (payloads) => {
    // The last state of each send in the burst decides its toast.
    const last = new Map<string, OutboxChangedPayload>();
    for (const payload of payloads) {
      const event = outboxEvent(payload);
      if (event !== null) last.set(event.id, event);
    }
    if (last.size === 0) return;
    void loadOutbox().then((rows) => {
      for (const event of last.values()) {
        const toastId = sendToastId(event.id);
        const row = rows?.find((r) => r.id === event.id) ?? null;
        switch (event.state) {
          case "queued":
            showUndo(event.id, row?.sendAfter ?? null, row?.origin, row?.purpose);
            break;
          case "sending":
          case "cancelled":
            toast.dismiss(toastId);
            break;
          case "done":
            toast.success(tx("Sent"), { id: toastId });
            break;
          case "failed":
            toast.error(row !== null ? outboxStateText(row) : tx("Not sent"), {
              id: toastId,
              action: { label: tx("Retry"), onClick: () => void outboxAction(event.id, "retry") },
            });
            break;
          case "unknown":
            toast.error(tx("May have been sent \u2014 see the Outbox in Sent"), { id: toastId });
            break;
          case "sent_no_copy":
            toast.error(row !== null ? outboxStateText(row) : tx("Sent; the copy to Sent failed"), { id: toastId });
            break;
          case "waiting":
            // Not an error yet: Mail tries again on its own (slice 3j).
            toast(row !== null ? outboxStateText(row) : tx("Not sent yet. Mail will try again."), { id: toastId });
            break;
          case "held":
          case "sent":
          case "appending":
            break;
        }
      }
    });
  });

  /** An Outbox row's button (and the failed toast's Retry). */
  const outboxAction = useCallback(
    async (id: string, action: OutboxAction) => {
      if (action === "undo") {
        await undoSend(id);
        return;
      }
      if (action === "edit") {
        await undoSend(id, "This send can no longer be edited");
        return;
      }
      setOutboxPending((prev) => new Set(prev).add(id));
      try {
        if (action === "send_now") await rpc.call("outbox_send_now", { id });
        else if (action === "retry" || action === "retry_copy") await rpc.call("outbox_retry", { id });
        else if (action === "resend") await rpc.call("outbox_resend", { id });
        else await rpc.call("outbox_dismiss", { id });
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        setOutboxPending((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        void loadOutbox();
      }
    },
    [loadOutbox, rpc, undoSend],
  );

  const closeComposer = useCallback(() => {
    setComposer(null);
    refreshAfterChange();
  }, [refreshAfterChange]);

  const sent = useCallback(
    (queued: { outboxId: string; sendAfter: string }) => {
      setComposer(null);
      showUndo(queued.outboxId, queued.sendAfter);
      void loadOutbox();
      refreshAfterChange();
    },
    [loadOutbox, refreshAfterChange, showUndo],
  );

  const smtpCall = useCallback(
    async (method: "accounts_smtp_test" | "accounts_smtp_set", input: SmtpSettingsInput) => {
      try {
        const result = await rpc.call(method, input);
        if (method === "accounts_smtp_set" && result.ok) void loadStatus();
        return result;
      } catch (error) {
        return { ok: false, reason: messageOf(error) };
      }
    },
    [loadStatus, rpc],
  );

  // ---- Inbox triage on the page (slice 3e): filters, unsubscribe, snooze, block ----

  const listFilter = filtersRef.current.get(currentViewKey) ?? NO_FILTER;

  /** Split Inbox: the row's ports. The tab in view is the routed one while it still exists. */
  const shownTabs = inboxShown && tabState !== null && tabState.key === currentViewKey ? tabState : null;
  const tabPorts = useMemo((): MailTabsPorts => {
    const tabs = shownTabs?.tabs ?? [];
    const currentId = tabs.some((tab) => tab.id === routeTab) ? routeTab : null;
    const open = (id: string | null) => navigate.toPluginPanel("mail", { subPath: viewTabSubPath(latest.current.view, id) });
    // Any change may move conversations in or out of the tab in view (its own condition, or Other's rest).
    const relist = () => {
      if (latest.current.tab !== null && latest.current.scopeKey !== null) void loadList(latest.current.view, "reset");
    };
    const save = async (input: { id?: string; name: string; query: string }) => {
      await rpc.call("inbox_tab_save", input);
      await loadTabs();
      relist();
    };
    const change = (call: Promise<unknown>, after?: () => void) => {
      call.then(
        () => {
          after?.();
          void loadTabs();
          relist();
        },
        (error) => toast.error(tx("Could not change the tabs: {p1}", { p1: messageOf(error) })),
      );
    };
    return {
      shown: inboxShown,
      tabs,
      currentId,
      inboxUnread: shownTabs?.inboxUnread ?? 0,
      onSelect: (id) => {
        if (id !== currentId) open(id);
      },
      onStep: (delta) => {
        if (tabs.length === 0) return;
        const order: (string | null)[] = [null, ...tabs.map((tab) => tab.id)];
        open(order[(order.indexOf(currentId) + delta + order.length) % order.length] ?? null);
      },
      onAdd: (tab) => save(tab),
      onRename: async (id, name) => {
        const tab = tabs.find((t) => t.id === id);
        if (tab !== undefined) await save({ id, name, query: tab.query });
      },
      onEdit: async (id, query) => {
        const tab = tabs.find((t) => t.id === id);
        if (tab !== undefined) await save({ id, name: tab.name, query });
      },
      onMove: (id, direction) => change(rpc.call("inbox_tab_move", { id, direction })),
      onRemove: (id) =>
        change(rpc.call("inbox_tab_delete", { id }), () => {
          if (id === latest.current.tab) open(null);
        }),
      onSplitSender: ({ name, address }) => {
        const tabName = (name?.trim() || address).slice(0, TAB_NAME_MAX);
        save({ name: tabName, query: `from:${address}` }).then(
          () => toast(tx("Added the tab {p1}", { p1: tabName })),
          (error) => toast.error(tx("Could not add the tab: {p1}", { p1: messageOf(error) })),
        );
      },
    };
  }, [inboxShown, shownTabs, routeTab, navigate, rpc, loadTabs, loadList]);
  /** A toggle: the view keeps it while the page is open, and the list starts again. */
  const setListFilter = useCallback(
    (next: ListFilter) => {
      const key = viewKey(latest.current.view);
      const filters = new Map(filtersRef.current);
      if (filterActive(next)) filters.set(key, next);
      else filters.delete(key);
      filtersRef.current = filters;
      setFilterVersion((n) => n + 1);
      setSelection(NO_SELECTION);
      if (latest.current.scopeKey !== null) void loadList(latest.current.view, "reset");
    },
    [loadList],
  );

  /** unsubscribe_info of the open conversation's newest message, once per message. */
  const [unsubscribe, setUnsubscribe] = useState<{ messageId: string; info: UnsubscribeInfoView } | null>(null);
  const unsubscribeToken = useRef(0);
  const loadUnsubscribe = useCallback(
    async (messageId: string) => {
      const token = ++unsubscribeToken.current;
      try {
        const info = await rpc.call("unsubscribe_info", { messageId });
        if (token === unsubscribeToken.current) setUnsubscribe({ messageId, info });
      } catch {
        // Nothing is offered for a message the server cannot answer for.
        if (token === unsubscribeToken.current) setUnsubscribe(null);
      }
    },
    [rpc],
  );
  const handedId =
    reading.detail === null ? null : (messageToHand(reading.detail.messages, reading.expandedIds)?.id ?? null);
  useEffect(() => {
    if (handedId === null) {
      unsubscribeToken.current++;
      setUnsubscribe(null);
      return;
    }
    void loadUnsubscribe(handedId);
  }, [handedId, loadUnsubscribe]);

  const [unsubscribeAsk, setUnsubscribeAsk] = useState<{
    message: MessageHeader;
    info: UnsubscribeInfoView;
    method: UnsubscribeMethod;
  } | null>(null);
  const askUnsubscribe = useCallback(
    (message: MessageHeader, method?: UnsubscribeMethod) => {
      const loaded = latest.current.unsubscribe;
      if (loaded === null || loaded.messageId !== message.id) return;
      const chosen = method ?? preferredMethod(loaded.info);
      if (chosen !== null) setUnsubscribeAsk({ message, info: loaded.info, method: chosen });
    },
    [],
  );

  /** The confirmed request, a fresh requestId each time; the result as a toast. */
  const runUnsubscribe = useCallback(
    async (message: MessageHeader, info: UnsubscribeInfoView, method: UnsubscribeMethod) => {
      const viaEmail =
        method === "one_click" && info.methods.mailto !== null
          ? { label: tx("Send an email instead"), onClick: () => askUnsubscribe(message, "mailto") }
          : undefined;
      try {
        const result = await rpc.call("unsubscribe_run", {
          messageId: message.id,
          method,
          requestId: crypto.randomUUID(),
        });
        switch (result.outcome) {
          case "done":
            toast.success(tx("Unsubscribed"));
            break;
          case "redirected":
            toast(REDIRECTED_TEXT, viaEmail !== undefined ? { action: viaEmail } : undefined);
            break;
          case "failed":
            toast.error(
              tx("Could not unsubscribe: {p1}", { p1: unsubscribeFailureText(result.reason) }),
              viaEmail !== undefined ? { action: viaEmail } : undefined,
            );
            break;
          case "queued":
            if (result.outboxId !== null) showUndo(result.outboxId, null, "owner", "unsubscribe");
            void loadOutbox();
            break;
        }
      } catch (error) {
        toast.error(messageOf(error));
      }
      if (latest.current.unsubscribe?.messageId === message.id) void loadUnsubscribe(message.id);
    },
    [askUnsubscribe, loadOutbox, loadUnsubscribe, rpc, showUndo],
  );

  /** Sums a call's groups: one toast per distinct error, and what was queued. */
  const groupsOutcome = (groups: readonly { queued: number; error: string | null }[]) => {
    for (const error of new Set(groups.map((g) => g.error).filter((e): e is string => e !== null))) toast.error(error);
    return groups.reduce((sum, g) => sum + (g.error === null ? g.queued : 0), 0);
  };

  const archiveList = useCallback(
    async (message: MessageHeader) => {
      const undoId = crypto.randomUUID();
      try {
        const { groups, undoable } = await rpc.call("unsubscribe_archive", { messageId: message.id, undoId });
        const queued = groupsOutcome(groups);
        if (queued === 0) {
          if (groups.every((g) => g.error === null)) toast(tx("Nothing from this list is left in the Inbox"));
          return;
        }
        if (undoable) recordUndo(undoId, "archive", queued, null, true);
        else toast.success(tx("Archived {p1}", { p1: plural(queued, "message", "messages") }));
        refreshAfterChange();
      } catch (error) {
        toast.error(messageOf(error));
      }
    },
    [recordUndo, refreshAfterChange, rpc],
  );

  /** The snooze folder question, one account at a time; then the snooze runs again for those. */
  const [folderAsk, setFolderAsk] = useState<{
    pending: { accountId: string; proposedName: string }[];
    threadIds: string[];
    until: string;
  } | null>(null);
  const askFolders = useAccountFolders(folderAsk?.pending[0]?.accountId ?? null);

  const snoozeThreads = useCallback(
    async (threadIds: string[], until: string, then?: (() => void) | null) => {
      if (threadIds.length === 0 || pendingRef.current) return;
      pendingRef.current = true;
      setActionPending(true);
      const snapshot = latest.current.reading;
      const ctx: ViewContext = { view: latest.current.view, folders: latest.current.folders };
      try {
        const collected = await collect(threadIds, snapshot, ctx);
        for (const error of new Set(collected.failures.values())) toast.error(error);
        const items = collected.items;
        if (items.length === 0) return;
        const undoId = crypto.randomUUID();
        const done = new Set<string>();
        const needs = new Map<string, string>();
        let undoable = false;
        for (let start = 0; start < items.length; start += ACTION_CHUNK) {
          const chunk = items.slice(start, start + ACTION_CHUNK);
          try {
            const result = await rpc.call("message_snooze", {
              messageIds: chunk.map((item) => item.id),
              ...sourceOf(ctx.view),
              until,
              undoId,
            });
            if (result.undoable) undoable = true;
            groupsOutcome(result.groups);
            for (const group of result.groups) {
              if (group.error !== null || group.queued === 0) continue;
              for (const item of chunk) {
                if (item.accountId === group.accountId && item.folder === group.folder) done.add(item.threadId);
              }
            }
            for (const entry of result.needsFolder) needs.set(entry.accountId, entry.proposedName);
          } catch (error) {
            toast.error(messageOf(error));
          }
        }
        if (done.size > 0) {
          if (undoable) recordUndo(undoId, "snooze", done.size, formatUntil(until), true);
          else toast.success(undoToastText("snooze", done.size, formatUntil(until)));
          setSelection((prev) => ([...prev].some((id) => done.has(id)) ? new Set([...prev].filter((id) => !done.has(id))) : prev));
          setList((prev) => ({ ...prev, threads: prev.threads.filter((t) => !done.has(t.id)) }));
          const open = latest.current.reading.threadId;
          if (open !== null && done.has(open)) advanceOrClose(open, snapshot.threadId, then, undoable ? undoId : null);
          refreshAfterChange();
        }
        if (needs.size > 0) {
          const waiting = [...new Set(items.filter((item) => needs.has(item.accountId)).map((item) => item.threadId))];
          setFolderAsk({
            pending: [...needs].map(([accountId, proposedName]) => ({ accountId, proposedName })),
            threadIds: waiting,
            until,
          });
        }
      } finally {
        pendingRef.current = false;
        setActionPending(false);
      }
    },
    [advanceOrClose, collect, recordUndo, refreshAfterChange, rpc],
  );

  /** One account's folder is settled: the next account, or the snooze again. */
  const folderSettled = useCallback(() => {
    const ask = folderAsk;
    if (ask === null) return;
    const rest = ask.pending.slice(1);
    const key = latest.current.scopeKey;
    if (key !== null) void loadFolders(key);
    if (rest.length > 0) {
      setFolderAsk({ ...ask, pending: rest });
      return;
    }
    setFolderAsk(null);
    void snoozeThreads(ask.threadIds, ask.until);
  }, [folderAsk, loadFolders, snoozeThreads]);

  const folderRequest: SnoozeFolderRequest | null =
    folderAsk === null || folderAsk.pending[0] === undefined
      ? null
      : {
          accountId: folderAsk.pending[0].accountId,
          accountLabel: accounts.find((a) => a.id === folderAsk.pending[0]!.accountId)?.email ?? "this account",
          proposedName: folderAsk.pending[0].proposedName,
          current: null,
        };

  const returnNow = useCallback(
    async (threadId: string) => {
      const detail = latest.current.reading.detail;
      if (detail === null || detail.thread.id !== threadId) return;
      try {
        const { ok } = await rpc.call("message_unsnooze", { messageIds: detail.messages.map((m) => m.id) });
        toast(ok ? tx("Coming back to the Inbox") : tx("Nothing here is snoozed any more"));
        refreshAfterChange();
      } catch (error) {
        toast.error(messageOf(error));
      }
    },
    [refreshAfterChange, rpc],
  );

  const blockSender = useCallback(
    async (messageId: string, choice: BlockChoice) => {
      const undoId = crypto.randomUUID();
      try {
        const { groups, undoable } = await rpc.call("block_add", {
          messageId,
          kind: choice.kind,
          moveExisting: choice.moveExisting,
          undoId,
        });
        const moved = groupsOutcome(groups);
        if (undoable) recordUndo(undoId, "block", moved, null, true);
        else toast.success(undoToastText("block", moved, null));
        if (moved > 0) {
          const open = latest.current.reading;
          if (open.detail?.messages.some((m) => m.id === messageId) === true) closeThread();
          refreshAfterChange();
        }
      } catch (error) {
        toast.error(messageOf(error));
      }
    },
    [closeThread, recordUndo, refreshAfterChange, rpc],
  );

  latest.current.unsubscribe = unsubscribe;
  const inboxPorts = useMemo<MailInboxPorts>(
    () => ({
      unsubscribe,
      onUnsubscribe: (message) => askUnsubscribe(message),
      onArchiveList: (message) => void archiveList(message),
      onSnooze: (threadIds, until, then) => void snoozeThreads(threadIds, until, then),
      onReturnNow: (threadId) => void returnNow(threadId),
      loadBlockCheck: (messageId) => rpc.call("block_check", { messageId }),
      onBlock: (messageId, choice) => void blockSender(messageId, choice),
    }),
    [archiveList, askUnsubscribe, blockSender, returnNow, rpc, snoozeThreads, unsubscribe],
  );

  // ---- Translation (slice 3c) ----

  const [translation, setTranslation] = useState<{ messageId: string; state: TranslationState } | null>(null);
  const translationRef = useRef(translation);
  translationRef.current = translation;
  const [translateSettingsOpen, setTranslateSettingsOpen] = useState(false);
  /** A Translate that waits for the first-use settings. */
  const translateAfterSettings = useRef<string | null>(null);
  /** The running job; a new serial ends any poll loop of an older one. */
  const translateJob = useRef<string | null>(null);
  const translateSerial = useRef(0);
  /** The default target language, once read from the settings. */
  const translateLanguage = useRef<string | null>(null);

  /** Ends the poll loop and cancels the job on the server, if one runs. */
  const stopTranslateJob = useCallback(() => {
    translateSerial.current++;
    const jobId = translateJob.current;
    translateJob.current = null;
    if (jobId !== null) rpc.call("translate_cancel", { jobId }).catch(() => undefined);
  }, [rpc]);

  const runTranslation = useCallback(
    async (messageId: string, language: string, force: boolean) => {
      stopTranslateJob();
      const serial = translateSerial.current;
      const live = () => translateSerial.current === serial;
      const patch = (next: (state: TranslationState) => Partial<TranslationState>) => {
        if (!live()) return;
        setTranslation((prev) =>
          prev !== null && prev.messageId === messageId ? { messageId, state: { ...prev.state, ...next(prev.state) } } : prev,
        );
      };
      setTranslation({ messageId, state: TRANSLATION_STARTING(language) });
      let started: Awaited<ReturnType<typeof rpc.call<"translate_start">>>;
      try {
        started = await rpc.call("translate_start", {
          messageId,
          targetLanguage: language as LanguageTag,
          ...(force ? { force: true } : {}),
        });
      } catch {
        patch(() => ({ status: "failed", error: "failed" }));
        return;
      }
      if ("cached" in started) {
        const cached = started.cached;
        patch(() => ({
          status: "done",
          text: cached.text,
          provider: cached.providerId,
          model: cached.model,
          cached: cached.cached,
          incomplete: cached.truncated,
        }));
        return;
      }
      const { jobId } = started;
      if (!live()) {
        rpc.call("translate_cancel", { jobId }).catch(() => undefined);
        return;
      }
      translateJob.current = jobId;
      let from = 0;
      while (live()) {
        await new Promise((resolve) => setTimeout(resolve, TRANSLATE_POLL_MS));
        if (!live()) return;
        // Polled only while the page is visible; the server ends a job nobody polls.
        if (typeof document !== "undefined" && document.visibilityState === "hidden") continue;
        let poll: Awaited<ReturnType<typeof rpc.call<"translate_poll">>>;
        try {
          poll = await rpc.call("translate_poll", { jobId, from });
        } catch {
          if (live()) translateJob.current = null;
          patch(() => ({ status: "failed", error: "failed" }));
          return;
        }
        if (!live()) return;
        from += poll.text.length;
        patch((prev) => ({
          status: poll.state === "running" ? "running" : poll.state,
          text: prev.text + poll.text,
          provider: poll.provider ?? prev.provider,
          model: poll.model ?? prev.model,
          truncatedInput: poll.truncatedInput ?? prev.truncatedInput,
          cutShort: poll.finish === "max_tokens",
          error: poll.error ?? null,
          gatewayMessage: poll.gatewayMessage ?? null,
        }));
        if (poll.state !== "running") {
          translateJob.current = null;
          if (poll.error === "gateway_missing") void loadStatus();
          return;
        }
      }
    },
    [loadStatus, rpc, stopTranslateJob],
  );

  /** Translate, or Show original when that message's translation is shown. */
  const toggleTranslation = useCallback(
    (message: MessageHeader) => {
      if (translationRef.current?.messageId === message.id) {
        stopTranslateJob();
        setTranslation(null);
        return;
      }
      void (async () => {
        let language = translateLanguage.current;
        if (language === null) {
          try {
            const settings = await rpc.call("translate_settings_get", {});
            language = settings.current.language;
            translateLanguage.current = language;
            // First use: the owner picks the provider and model before anything is sent.
            if (settings.current.providerId === "" && settings.current.model === "") {
              translateAfterSettings.current = message.id;
              setTranslateSettingsOpen(true);
              return;
            }
          } catch (error) {
            toast.error(tx("Could not start the translation: {p1}", { p1: messageOf(error) }));
            return;
          }
        }
        await runTranslation(message.id, language, false);
      })();
    },
    [rpc, runTranslation, stopTranslateJob],
  );

  // Another conversation, or leaving the page, ends the translation.
  useEffect(() => {
    stopTranslateJob();
    setTranslation(null);
  }, [reading.threadId, stopTranslateJob]);
  useEffect(() => stopTranslateJob, [stopTranslateJob]);

  const translationBlock = useMemo(() => {
    if (translation === null) return null;
    const { messageId, state } = translation;
    return {
      messageId,
      block: (
        <TranslationBlock
          state={state}
          onStop={() => {
            stopTranslateJob();
            setTranslation((prev) =>
              prev !== null && prev.messageId === messageId ? { messageId, state: { ...prev.state, status: "cancelled" } } : prev,
            );
          }}
          onAgain={() => void runTranslation(messageId, state.language, true)}
          onLanguage={(tag) => {
            translateLanguage.current = tag;
            void runTranslation(messageId, tag, false);
          }}
          onSettings={() => setTranslateSettingsOpen(true)}
        />
      ),
    };
  }, [runTranslation, stopTranslateJob, translation]);

  const readingTranslation = useMemo<ReadingTranslation>(
    () => ({
      disabledReason: status?.translate.gateway === "gateway_missing" ? TRANSLATE_MISSING : null,
      shown: translationBlock,
      onToggle: toggleTranslation,
    }),
    [status?.translate.gateway, toggleTranslation, translationBlock],
  );

  const loadTranslateSettings = useCallback(() => rpc.call("translate_settings_get", {}), [rpc]);
  const saveTranslateSettings = useCallback(
    async (input: { providerId: string; model: string; language: string }) => {
      await rpc.call("translate_settings_set", { ...input, language: input.language as LanguageTag });
      translateLanguage.current = input.language;
    },
    [rpc],
  );
  const clearTranslations = useCallback(async () => (await rpc.call("translate_clear", {})).removed, [rpc]);
  const translateSettingsChanged = useCallback(
    (open: boolean) => {
      setTranslateSettingsOpen(open);
      if (!open) translateAfterSettings.current = null;
    },
    [],
  );
  const translateSettingsSaved = useCallback(() => {
    const pending = translateAfterSettings.current;
    translateAfterSettings.current = null;
    if (pending !== null && translateLanguage.current !== null) {
      void runTranslation(pending, translateLanguage.current, false);
    }
  }, [runTranslation]);

  // ---- Mail settings: sending addresses, signatures, templates (slice 3d) ----

  /** The settings section the address names; null on every other page. */
  const settingsSection = parseSettingsSubPath(subPath);
  const [identities, setIdentities] = useState<IdentityView[]>([]);
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const loadIdentities = useCallback(async () => {
    try {
      setIdentities((await rpc.call("identities_list", { accountId: null })).identities);
    } catch {
      // The composer falls back to the accounts' own addresses.
    }
  }, [rpc]);
  const loadTemplates = useCallback(async () => {
    try {
      setTemplates((await rpc.call("templates_list", {})).templates as TemplateView[]);
    } catch {
      // Settings and the picker show what was loaded last.
    }
  }, [rpc]);
  const accountIds = accounts.map((a) => a.id).join(",");
  useEffect(() => {
    if (status?.vaultReady !== true || accountIds === "") return;
    void loadIdentities();
    void loadTemplates();
  }, [accountIds, loadIdentities, loadTemplates, status?.vaultReady]);
  /** Blocked senders for Mail settings (slice 3e); null while they load. */
  const [blockRules, setBlockRules] = useState<BlockRuleView[] | null>(null);
  const loadBlockRules = useCallback(async () => {
    try {
      setBlockRules((await rpc.call("block_list", {})).rules);
    } catch {
      setBlockRules((prev) => prev ?? []);
    }
  }, [rpc]);
  const openSettings = useCallback(
    (section?: SettingsSection) => {
      navigate.toPluginPanel("mail", { subPath: settingsSubPath(section) });
    },
    [navigate],
  );
  // The page's lists and settings load when it opens, by a click or by its address.
  const settingsShown = settingsSection !== null;
  const [loadedSettings, setLoadedSettings] = useState<PageSettings | null>(null);
  useEffect(() => {
    if (!settingsShown) return;
    void loadIdentities();
    void loadTemplates();
    void loadBlockRules();
    rpc.call("settings_get", {}).then(setLoadedSettings, () => undefined);
  }, [settingsShown, loadBlockRules, loadIdentities, loadTemplates, rpc]);
  // BB's live settings are the truth: they also change in BB's own plugin settings while
  // the page is open. What the page has just written covers them until BB reports a change.
  const liveSettings = useSettings().values as Record<string, unknown> | null | undefined;
  const liveSignature = liveSettings == null ? null : JSON.stringify(liveSettings);
  const [writtenSettings, setWrittenSettings] = useState<Partial<PageSettings>>({});
  useEffect(() => setWrittenSettings({}), [liveSignature]);
  const pageSettings = useMemo<PageSettings | null>(() => {
    const base = liveSignature === null ? loadedSettings : pageSettingsOf(JSON.parse(liveSignature) as Record<string, unknown>);
    return base === null ? null : { ...base, ...writtenSettings };
  }, [liveSignature, loadedSettings, writtenSettings]);
  /** Writes of the settings page go one after another, in the order they were made. */
  const settingsWrites = useRef<Promise<unknown>>(Promise.resolve());
  const pageSettingsPort = useMemo<PageSettingsPort>(
    () => ({
      values: pageSettings,
      save: (patch) => {
        // Refused here with a reason the owner can read; the server checks the same bounds again.
        if (!pageSettingsPatchSchema.safeParse(patch).success) {
          return Promise.resolve<SaveResult>({ ok: false, message: tx("This value is not allowed here.") });
        }
        const write = settingsWrites.current.then(async (): Promise<SaveResult> => {
          try {
            const saved = await rpc.call("settings_set", patch);
            setLoadedSettings(saved);
            setWrittenSettings((prev) => ({ ...prev, ...patch }));
            return { ok: true };
          } catch (error) {
            return { ok: false, message: tx(messageOf(error)) };
          }
        });
        settingsWrites.current = write;
        return write;
      },
    }),
    [pageSettings, rpc],
  );
  /** Mail settings' Change… for an account's snooze folder. */
  const [settingsFolder, setSettingsFolder] = useState<SnoozeFolderRequest | null>(null);
  const settingsFolders = useAccountFolders(settingsFolder?.accountId ?? null);
  const changeSnoozeFolder = useCallback(
    (accountId: string) => {
      const target = accounts.find((a) => a.id === accountId);
      if (target === undefined) return;
      setSettingsFolder({
        accountId,
        accountLabel: target.email,
        proposedName: snoozeFolderName(target.preset),
        current: target.snoozeFolder ?? null,
      });
    },
    [accounts],
  );
  // ---- Slice 3f: plugin settings the page reads, and Mail settings' AI tabs ----

  // Slice 3k: OpenPGP keys in Mail settings.
  // Access of other plugins: requests wait in settings; a new one is announced once.
  /** Split Inbox: the Tabs group of Mail settings; the row over the Inbox follows a change. */
  const settingsTabs = useMemo<InboxTabsPort>(() => {
    const done = () => void loadTabs();
    return {
      load: async () => (await rpc.call("inbox_tabs_list", { scope: { kind: "all", role: "inbox" }, counts: false })).tabs,
      save: async (input) => {
        await rpc.call("inbox_tab_save", input);
        done();
      },
      move: async (id, direction) => {
        await rpc.call("inbox_tab_move", { id, direction });
        done();
      },
      remove: async (id) => {
        await rpc.call("inbox_tab_delete", { id });
        done();
      },
    };
  }, [rpc, loadTabs]);
  const [pluginAccessTick, setPluginAccessTick] = useState(0);
  /** The one Google sign-in started for a plugin key; a new click or leaving the page ends its wait. */
  const googleGrantRun = useRef<AbortController | null>(null);
  useEffect(() => () => googleGrantRun.current?.abort(), []);
  const [pluginRequests, setPluginRequests] = useState(0);
  const settingsPluginAccess = useMemo<PluginAccessPort>(() => {
    const save = async (work: () => Promise<unknown>): Promise<SaveResult> => {
      try {
        await work();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: tx(messageOf(error)) };
      }
    };
    return {
      load: async () => {
        const view = await rpc.call("plugin_grants_list", {});
        setPluginRequests(view.requests.length);
        return view;
      },
      setGrant: (pluginId, right, accountId, on) => save(() => rpc.call("plugin_grant_set", { pluginId, right, accountId, on })),
      revoke: (pluginId) => save(() => rpc.call("plugin_grant_revoke", { pluginId })),
      dismiss: (pluginId) => save(() => rpc.call("plugin_request_dismiss", { pluginId })),
    };
  }, [rpc]);
  useRealtime(PLUGIN_ACCESS_CHANNEL, (payload) => {
    setPluginAccessTick((n) => n + 1);
    const asked = (payload as PluginAccessPayload | null)?.request;
    if (typeof asked !== "string") return;
    setPluginRequests((n) => Math.max(n, 1));
    toast(tx("{plugin} asks for access to mail. Open Mail settings to decide.", { plugin: asked.slice(0, 60) }), {
      id: "plugin-access-request",
      action: { label: tx("Open"), onClick: () => openSettings("plugin_access") },
    });
  });
  const settingsPgp = useMemo<SettingsPgpPorts>(
    () => ({
      list: () => rpc.call("pgp_certs_list", {}),
      generate: async (accountId, address) => {
        await rpc.call("pgp_cert_generate", { accountId, address });
      },
      importArmor: (armor, phrase) => rpc.call("pgp_cert_import", phrase === undefined ? { armor } : { armor, phrase }),
      remove: async (id) => {
        await rpc.call("pgp_cert_remove", { id });
      },
      exportArmor: (id, phrase) => rpc.call("pgp_cert_export", phrase === undefined ? { id } : { id, phrase }),
    }),
    [rpc],
  );
  // Slice 3m: filters over new Inbox mail.
  const settingsFilters = useMemo<SettingsFilterPorts>(
    () => ({
      list: async () => (await rpc.call("filters_list", {})).filters,
      save: async (input) => {
        await rpc.call("filter_save", input);
      },
      remove: async (id) => {
        await rpc.call("filter_delete", { id });
      },
      folders: async (accountId) => (await rpc.call("folders_list", { accountId })).folders,
    }),
    [rpc],
  );
  // Slice 3n: the subscriptions overview. Each request is the message's own Unsubscribe.
  const settingsSubscriptions = useMemo<SettingsSubscriptionPorts>(
    () => ({
      list: () => rpc.call("subscriptions_list", { accountId: null }),
      run: async (messageId, method) => {
        const result = await rpc.call("unsubscribe_run", { messageId, method, requestId: crypto.randomUUID() });
        if (result.outcome === "queued") {
          if (result.outboxId !== null) showUndo(result.outboxId, null, "owner", "unsubscribe");
          void loadOutbox();
        }
        return { outcome: result.outcome, reason: result.reason };
      },
    }),
    [loadOutbox, rpc, showUndo],
  );
  const pluginSettings = useSettings().values;
  cleanLinksOn.current = pluginSettings?.cleanLinks !== false;
  // Typing speed: the owner's phrases for the grey text, read when a composer opens (the server keeps them ten minutes).
  const [phrases, setPhrases] = useState<readonly string[]>([]);
  const composerOpen = mailComposer !== null;
  const autocompleteOn = pluginSettings?.autocomplete !== false;
  useEffect(() => {
    if (!composerOpen || !autocompleteOn) return;
    let live = true;
    rpc.call("phrases_list", {}).then(
      (result) => {
        if (live) setPhrases(result.phrases);
      },
      // Without phrases there is no grey text; nothing else depends on them.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [composerOpen, autocompleteOn, rpc]);
  // Typing speed: the composer's aids.
  const pairsText = typeof pluginSettings?.autocorrectPairs === "string" ? pluginSettings.autocorrectPairs : "";
  const typing = useMemo<TypingOptions>(
    () => ({
      autocorrect: pluginSettings?.autocorrect !== false,
      pairs: parsePairs(pairsText),
      autocomplete: pluginSettings?.autocomplete !== false,
      phrases,
    }),
    [pluginSettings?.autocorrect, pluginSettings?.autocomplete, pairsText, phrases],
  );
  // Slice 3h: the reading settings and the Search and reading tab.
  const readingSettings = {
    mailView: pluginSettings?.mailView === "plain" ? ("plain" as const) : ("original" as const),
    darkMail: pluginSettings?.darkMail === "original" ? ("original" as const) : ("adapt" as const),
    hideQuotes: pluginSettings?.hideQuotes !== false,
    cleanLinks: pluginSettings?.cleanLinks !== false,
  };
  const settingsSearch = useMemo<SettingsSearchPorts>(
    () => ({
      values: {
        historyStepDays: typeof pluginSettings?.historyStepDays === "number" ? pluginSettings.historyStepDays : 30,
        serverSearchKeepDays: typeof pluginSettings?.serverSearchKeepDays === "number" ? pluginSettings.serverSearchKeepDays : 14,
        indexAttachmentText: pluginSettings?.indexAttachmentText === true,
        mailView: pluginSettings?.mailView === "plain" ? "plain" : "original",
        darkMail: pluginSettings?.darkMail === "original" ? "original" : "adapt",
        hideQuotes: pluginSettings?.hideQuotes !== false,
        cleanLinks: pluginSettings?.cleanLinks !== false,
      },
      loadStatus: () => rpc.call("attachment_text_status", {}),
      retry: async () => {
        await rpc.call("attachment_text_retry", {});
      },
      clear: async () => {
        await rpc.call("attachment_text_clear", {});
      },
    }),
    [
      pluginSettings?.darkMail,
      pluginSettings?.hideQuotes,
      pluginSettings?.cleanLinks,
      pluginSettings?.historyStepDays,
      pluginSettings?.indexAttachmentText,
      pluginSettings?.mailView,
      pluginSettings?.serverSearchKeepDays,
      rpc,
    ],
  );
  /** Slice 3g: the owner RPCs of the BB integration, typed for src/ui. */
  const bbCall = useCallback<BbCall>(
    (method, input) => rpc.call(method as never, input as never) as never,
    [rpc],
  );
  const bbSettings = useMemo<BbSettingsValues>(
    () => ({
      attachmentFolder: typeof pluginSettings?.attachmentFolder === "string" ? pluginSettings.attachmentFolder : "mail-attachments",
      patchFolder: typeof pluginSettings?.patchFolder === "string" ? pluginSettings.patchFolder : "mail-patches",
      taskTarget:
        pluginSettings?.taskTarget === "taskboard" || pluginSettings?.taskTarget === "local" ? pluginSettings.taskTarget : "auto",
      devNotifications: pluginSettings?.devNotifications !== false,
    }),
    [pluginSettings?.attachmentFolder, pluginSettings?.devNotifications, pluginSettings?.patchFolder, pluginSettings?.taskTarget],
  );
  const mailRulesOn = pluginSettings?.mailRules === true;
  const categoriesOn = pluginSettings?.mailCategories === true;
  const reminderDaysSetting = (() => {
    const days = pluginSettings?.replyReminderDays;
    return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 30 ? days : 3;
  })();
  const morningDigest = pluginSettings?.morningDigest === true;
  const digestTime = typeof pluginSettings?.digestTime === "string" ? pluginSettings.digestTime : "08:00";
  const openConversation = useCallback(
    (accountId: string, threadId: string) => {
      navigate.toPluginPanel("mail", { subPath: threadSubPath(accountId, threadId) });
    },
    [navigate],
  );
  /** AI sorts the inbox: the owner's AI labels. Its own memo, so a settings change does not reload the list. */
  const aiLabelPorts = useMemo<NonNullable<SettingsAiPorts["labels"]>>(
    () => ({
      list: async () => (await rpc.call("ai_labels_list", {})).labels,
      save: async (input) => (await rpc.call("ai_label_save", input)).label,
      remove: async (id) => {
        await rpc.call("ai_label_delete", { id });
      },
      move: async (id, direction) => (await rpc.call("ai_label_move", { id, direction })).labels,
    }),
    [rpc],
  );
  const settingsAi = useMemo<SettingsAiPorts>(
    () => ({
      scope: {
        load: () => rpc.call("ai_scope_get", {}),
        save: (input) => rpc.call("ai_scope_set", input),
        folders: async (accountId) => (await rpc.call("folders_list", { accountId })).folders,
      },
      activity: {
        load: ({ threadId, cursor }) =>
          rpc.call("agent_log_list", { ...(threadId !== undefined ? { threadId } : {}), cursor, limit: 50 }),
        clear: async () => (await rpc.call("agent_log_clear", {})).removed,
        onOpen: openConversation,
      },
      categoriesOn,
      morningDigest,
      digestTime,
      reminderDays: reminderDaysSetting,
      loadRules: async () => (await rpc.call("category_rules_list", {})).rules,
      labels: aiLabelPorts,
      removeRule: async (id) => {
        await rpc.call("category_rule_remove", { id });
      },
      onOpenAiSettings: () => {
          setTranslateSettingsOpen(true);
      },
    }),
    [aiLabelPorts, categoriesOn, digestTime, morningDigest, openConversation, reminderDaysSetting, rpc],
  );
  const settingsContent = settingsSection === null ? undefined : (
    <SettingsPage
      section={settingsSection}
      onSection={(section) => navigate.toPluginPanel("mail", { subPath: settingsSubPath(section) })}
      onBack={() => navigate.toPluginPanel("mail", { subPath: viewSubPath(latest.current.view) })}
      settings={pageSettingsPort}
      vaultReady={status?.vaultReady !== false}
      onAddAccount={() => setAccountForm({})}
      onReplacePassword={(account) =>
        setAccountForm({ initial: { preset: account.preset, email: account.email, host: account.host, port: account.port } })
      }
      onCopy={(text) => void copy(text)}
      accounts={accounts}
      identities={identities}
      templates={templates}
      suggestions={async (accountId) => (await rpc.call("identity_suggestions", { accountId })).suggestions}
      onAdd={async (input) => {
        await rpc.call("identity_add", input);
        await loadIdentities();
      }}
      onUpdate={async (input) => {
        await rpc.call("identity_update", input as never);
        await loadIdentities();
      }}
      onRemove={async (input) => {
        await rpc.call("identity_remove", input);
        await loadIdentities();
      }}
      onDismiss={async (input) => {
        await rpc.call("identity_dismiss", input);
      }}
      onSaveTemplate={async (input) => {
        await rpc.call("template_save", input as never);
        await loadTemplates();
      }}
      onDeleteTemplate={async (id) => {
        await rpc.call("template_delete", { id });
        await loadTemplates();
      }}
      templateFiles={{
        // The bytes travel as a draft's do; only the first and the last call name the template.
        add: async (templateId, file) => {
          await uploadFile(
            {
              begin: ({ draftId, ...rest }) => rpc.call("template_file_begin", { templateId: draftId, ...rest }),
              chunk: (input) => rpc.call("compose_attachment_chunk", input),
              finish: async (input) => (await rpc.call("template_file_finish", input)).file as never,
            },
            templateId,
            file,
          );
          await loadTemplates();
        },
        remove: async (templateId, fileId) => {
          await rpc.call("template_file_remove", { templateId, fileId });
          await loadTemplates();
        },
      }}
      onOpenSmtp={(accountId) => {
          setSmtpAccountId(accountId);
      }}
      blockRules={blockRules}
      onUnblock={async (id) => {
        await rpc.call("block_remove", { id });
        await loadBlockRules();
      }}
      onChangeSnoozeFolder={changeSnoozeFolder}
      inboxTabs={settingsTabs}
      onGoogleSwitch={
        googleSignInOffered
          ? (account) => {
                      setAccountForm({ initial: { preset: "gmail", email: account.email, signIn: "google" } });
            }
          : undefined
      }
      ai={settingsAi}
      bb={{
        call: bbCall,
        values: bbSettings,
        mailRules: mailRulesOn,
        notify: (text, action) => {
          toast(text, action !== undefined ? { action: { label: action.label, onClick: action.run } } : undefined);
        },
      }}
      search={settingsSearch}
      pgp={settingsPgp}
      pluginAccess={{
        port: settingsPluginAccess,
        reloadKey: pluginAccessTick,
        waiting: pluginRequests,
        ...(googleSignInOffered
          ? {
              onGoogleGrant: (pluginId: string, right: PluginRight, accountId: string) => {
                const account = status?.accounts.find((a) => a.id === accountId);
                if (account === undefined || !isGoogleRight(right)) return;
                // The mailbox signs in again with this service added. The owner's click was for the key, so it is
                // turned on right after; Mail refuses it when Google did not give the service (the owner unticked it).
                googleGrantRun.current?.abort();
                const run = new AbortController();
                googleGrantRun.current = run;
                void googleSignIn(account.email, run.signal, [GOOGLE_RIGHT_SCOPE[right]])
                  .then(async (outcome) => {
                    if (!outcome.ok) {
                      if (outcome.message !== "") toast(outcome.message);
                      return;
                    }
                    const granted = await settingsPluginAccess.setGrant(pluginId, right, accountId, true);
                    toast(granted.ok ? tx("Signed in to Google; the key is on.") : tx("Google did not give this access, so the key stays off."));
                  })
                  .catch(() => toast(tx("Google sign-in did not finish.")))
                  .finally(() => setPluginAccessTick((n) => n + 1));
              },
            }
          : {}),
      }}
      filters={settingsFilters}
      subscriptions={settingsSubscriptions}
    />
  );

  // ---- Slice 3f: AI on the owner's click, categories, reply reminders ----

  const aiJobs = useMemo<AiJobPorts>(
    () => ({
      start: (input) => rpc.call("ai_start", input),
      poll: (jobId) => rpc.call("ai_poll", { jobId }),
      cancel: (jobId) => rpc.call("ai_cancel", { jobId }),
    }),
    [rpc],
  );
  /** One AI request to its end, for the page actions that show no block (Suggest categories). */
  const runAiToEnd = useCallback(
    async (input: AiStartInput): Promise<AiResultView> => {
      const started = await rpc.call("ai_start", input);
      if ("cached" in started) return started.cached;
      for (;;) {
        const poll = await rpc.call("ai_poll", { jobId: started.jobId });
        if (poll.state === "running") {
          await new Promise((resolve) => setTimeout(resolve, AI_POLL_MS));
          continue;
        }
        if (poll.state === "done" && poll.result !== undefined) return poll.result;
        throw new Error(AI_ERROR_TEXT[poll.error ?? (poll.state === "cancelled" ? "cancelled" : "failed")]);
      }
    },
    [rpc],
  );
  const [dueReminders, setDueReminders] = useState<ReminderView[]>([]);
  const loadReminders = useCallback(async () => {
    try {
      setDueReminders((await rpc.call("reminders_due", {})).reminders);
    } catch {
      // The strip keeps what it showed.
    }
  }, [rpc]);
  useEffect(() => {
    if (status?.vaultReady !== true || accountIds === "") return;
    void loadReminders();
  }, [accountIds, loadReminders, status?.vaultReady]);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, () => void loadReminders());
  useDebouncedRealtime(DAY_NOTICE_CHANNEL, () => void loadReminders());
  /** The list, and the open conversation, after a label changed. */
  const reloadAfterLabel = useCallback(() => {
    refreshAfterChange();
    const open = openThreadId.current;
    if (open !== null) void loadThread(open, null);
  }, [loadThread, refreshAfterChange]);
  const labelledToast = useCallback(
    (changed: number, undoId: string | null) => {
      if (changed === 0) {
        toast(tx("Nothing to label"));
        return;
      }
      toast(tx("Labelled {p1}", { p1: plural(changed, "message", "messages") }), {
        ...(undoId !== null
          ? {
              action: {
                label: tx("Undo"),
                onClick: () => {
                  rpc
                    .call("category_undo", { undoId })
                    .then(reloadAfterLabel)
                    .catch((error: unknown) => toast.error(tx("Could not undo: {p1}", { p1: messageOf(error) })));
                },
              },
            }
          : {}),
      });
    },
    [reloadAfterLabel, rpc],
  );
  /** The newest message in the view of each conversation, for page-wide label actions. */
  const latestMessages = useCallback(
    async (threadIds: readonly string[]) => {
      const { items } = await collect(threadIds, latest.current.reading, latest.current);
      const newest = new Map<string, string>();
      for (const item of items) newest.set(item.threadId, item.id);
      return [...newest.values()];
    },
    [collect],
  );
  const mailAi = useMemo<MailAiPorts>(
    () => ({
      jobs: aiJobs,
      disabledReason: status?.translate.gateway === "gateway_missing" ? tx(AI_ERROR_TEXT.gateway_missing) : null,
      keepTasks: async (jobId: string, picks: TaskPick[]) => {
        const { kept } = await rpc.call("tasks_keep", { jobId, picks });
        toast.success(kept === 1 ? tx("Kept 1 task") : tx("Kept {kept} tasks", { kept }));
        return kept;
      },
      onOpenConversation: (accountId, threadId) =>
        navigate.toPluginPanel("mail", { subPath: threadSubPath(accountId, threadId) }),
      categoriesOn,
      onCategorySet: (messageIds, category) => {
        rpc
          .call("category_set", { messageIds, category })
          .then(({ changed, undoId }) => {
            labelledToast(changed, undoId);
            reloadAfterLabel();
          })
          .catch((error: unknown) => toast.error(tx("Could not change the category: {p1}", { p1: messageOf(error) })));
      },
      // Ask AI with actions: each runs only on the owner's click, through what Mail already does.
      askActions: {
        reply: async (action) => {
          const prepared = await rpc.call("compose_prepare", { kind: "reply", messageId: action.messageId });
          const { draft } = await rpc.call("compose_open", { draftId: prepared.draftId });
          openComposer(draft, prepared.warning, prepared.dropped, action.threadId, action.paragraphs);
        },
        compose: async (paragraphs) => {
          const from = account?.id ?? accounts[0]?.id;
          if (from === undefined) throw new Error("Add an account first");
          const { draftId } = await rpc.call("compose_new", { accountId: from });
          const { draft, warning } = await rpc.call("compose_open", { draftId });
          openComposer(draft, warning, [], null, paragraphs);
        },
        act: (action) => runAskAct(rpc, action, { recordUndo, refresh: refreshAfterChange, warn: (text) => toast.error(text) }),
      },
      onCategoryAccept: (messageIds) => {
        rpc
          .call("category_accept", { messageIds })
          .then(({ changed, undoId }) => {
            labelledToast(changed, undoId);
            reloadAfterLabel();
          })
          .catch((error: unknown) => toast.error(tx("Could not accept the category: {p1}", { p1: messageOf(error) })));
      },
      onCategoryRule: (messageId, category: Category) => {
        rpc
          .call("category_rule_add", { messageId, kind: "address", category })
          .then(() => rpc.call("category_set", { messageIds: [messageId], category }))
          .then(({ changed, undoId }) => {
            toast.success(tx("New mail from this sender will be labelled {p1}", { p1: categoryLabel(category) }));
            if (changed > 0) labelledToast(changed, undoId);
            reloadAfterLabel();
          })
          .catch((error: unknown) => toast.error(tx("Could not add the rule: {p1}", { p1: messageOf(error) })));
      },
      onSuggestCategories: (threadIds) => {
        void (async () => {
          try {
            const ids = (await latestMessages(threadIds)).slice(0, 50);
            if (ids.length === 0) return;
            toast(tx("Suggesting categories\u2026"));
            const result = await runAiToEnd({ kind: "categories", messageIds: ids });
            const suggested = result.kind === "categories" ? result.items.filter((item) => item.category !== null).length : 0;
            toast(suggested === 1 ? tx("Suggested a category for 1 message") : tx("Suggested categories for {suggested} messages", { suggested }));
            reloadAfterLabel();
          } catch (error) {
            toast.error(tx("Could not suggest categories: {p1}", { p1: messageOf(error) }));
          }
        })();
      },
      onAcceptPage: (threadIds) => {
        void (async () => {
          try {
            const ids = await latestMessages(threadIds);
            if (ids.length === 0) return;
            const { changed, undoId } = await rpc.call("category_accept", { messageIds: ids.slice(0, 200) });
            labelledToast(changed, undoId);
            reloadAfterLabel();
          } catch (error) {
            toast.error(tx("Could not accept the categories: {p1}", { p1: messageOf(error) }));
          }
        })();
      },
      reminderDays: reminderDaysSetting,
      reminders: dueReminders,
      onRemind: (messageId, days) => {
        rpc
          .call("reminder_set", { messageId, days })
          .then(() => toast.success(tx("You will be reminded if no reply comes in {p1}", { p1: daysText(days) })))
          .catch((error: unknown) => toast.error(tx("Could not set the reminder: {p1}", { p1: messageOf(error) })));
      },
      onReminderSnooze: (reminder, days) => {
        rpc
          .call("reminder_snooze", { id: reminder.id, days })
          .then(() => {
            toast(tx("Reminding again in {p1}", { p1: daysText(days) }));
            void loadReminders();
          })
          .catch((error: unknown) => toast.error(tx("Could not change the reminder: {p1}", { p1: messageOf(error) })));
      },
      onReminderDismiss: (reminder) => {
        rpc
          .call("reminder_dismiss", { id: reminder.id })
          .then(() => void loadReminders())
          .catch((error: unknown) => toast.error(tx("Could not dismiss the reminder: {p1}", { p1: messageOf(error) })));
      },
    }),
    [
      account,
      accounts,
      aiJobs,
      categoriesOn,
      dueReminders,
      labelledToast,
      latestMessages,
      loadReminders,
      navigate,
      openComposer,
      recordUndo,
      refreshAfterChange,
      reloadAfterLabel,
      reminderDaysSetting,
      rpc,
      runAiToEnd,
      status?.translate.gateway,
    ],
  );

  // ---- Slice 3f: the Today and Tasks pages ----

  const shownPage = parsePageSubPath(subPath);
  const [pageCounts, setPageCounts] = useState<{ today: number | null; tasks: number | null; dev: number | null }>({
    today: null,
    tasks: null,
    dev: null,
  });
  const [pageRefresh, setPageRefresh] = useState(0);
  const loadPageCounts = useCallback(async () => {
    const [today, tasks] = await Promise.allSettled([rpc.call("today_get", {}), rpc.call("tasks_list", { done: false })]);
    setPageCounts({
      today: today.status === "fulfilled" ? today.value.needsReply.length : null,
      tasks: tasks.status === "fulfilled" ? tasks.value.tasks.length : null,
      dev: today.status === "fulfilled" ? (today.value.dev?.ciFailed ?? null) : null,
    });
  }, [rpc]);
  useEffect(() => {
    if (status?.vaultReady !== true || accountIds === "") return;
    void loadPageCounts();
  }, [accountIds, loadPageCounts, status?.vaultReady]);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, () => {
    void loadPageCounts();
    setPageRefresh((n) => n + 1);
  });
  /** A change on a page: its counts and lists load again. */
  const pageChanged = useCallback(() => {
    void loadPageCounts();
    void loadReminders();
  }, [loadPageCounts, loadReminders]);
  const showCategory = useCallback(
    (category: Category) => {
      setListFilter({ category });
      navigate.toPluginPanel("mail", { subPath: viewSubPath(latest.current.view) });
    },
    [navigate, setListFilter],
  );
  const loadToday = useCallback(() => rpc.call("today_get", {}), [rpc]);
  const loadDev = useCallback((cursor: string | null) => rpc.call("dev_digest_get", { cursor }), [rpc]);
  /** Mark read or Archive a Dev group: 3a's message action over its messages, with Undo. */
  const devAction = useCallback(
    async (group: { messageIds: string[] }, action: "mark_read" | "archive") => {
      if (group.messageIds.length === 0) return;
      const undoId = crypto.randomUUID();
      const result = await rpc.call("message_action", { messageIds: group.messageIds.slice(0, 200), action, role: "inbox", undoId });
      for (const error of new Set(result.groups.map((g) => g.error).filter((e): e is string => e !== null))) toast.error(error);
      if (result.undoable) recordUndo(undoId, action, group.messageIds.length, null, true);
      refreshAfterChange();
    },
    [recordUndo, refreshAfterChange, rpc],
  );
  const loadProjectLists = useCallback(async () => {
    const [projects, bindings] = await Promise.all([rpc.call("projects_list", {}), rpc.call("bindings_list", {})]);
    return { projects: projects.projects, bindings: bindings.bindings };
  }, [rpc]);
  const loadProjectMail = useCallback(
    (projectId: string, cursor: string | null) => rpc.call("project_mail", { projectId, cursor }),
    [rpc],
  );
  const loadTasks = useCallback(
    (done: boolean, cursor: string | null) => rpc.call("tasks_list", { done, cursor }),
    [rpc],
  );
  const pageContent =
    shownPage === "today" ? (
      <TodayView
        load={loadToday}
        jobs={aiJobs}
        aiDisabledReason={mailAi.disabledReason}
        onOpen={mailAi.onOpenConversation}
        onNoReply={async (threadId) => {
          await rpc.call("reply_dismiss", { threadId });
          pageChanged();
        }}
        reminderDays={reminderDaysSetting}
        onReminderSnooze={async (reminder, days) => {
          await rpc.call("reminder_snooze", { id: reminder.id, days });
          pageChanged();
        }}
        onReminderDismiss={async (reminder) => {
          await rpc.call("reminder_dismiss", { id: reminder.id });
          pageChanged();
        }}
        onTaskDone={async (task) => {
          await rpc.call("task_update", { id: task.id, done: true });
          pageChanged();
        }}
        {...(categoriesOn ? { onShowCategory: showCategory } : {})}
        {...(bbSettings.devNotifications ? { onOpenDev: () => navigate.toPluginPanel("mail", { subPath: pageSubPath("dev") }) } : {})}
        onReviewRules={() => navigate.toPluginPanel("mail", { subPath: viewSubPath(latest.current.view) })}
        refreshKey={pageRefresh}
      />
    ) : shownPage === "tasks" ? (
      <TasksView
        load={loadTasks}
        update={async (id, patch) => {
          await rpc.call("task_update", { id, ...patch });
          pageChanged();
        }}
        remove={async (id) => {
          await rpc.call("task_delete", { id });
          pageChanged();
        }}
        onOpen={(task) => {
          if (task.threadId !== null) mailAi.onOpenConversation(task.accountId, task.threadId);
        }}
        refreshKey={pageRefresh}
      />
    ) : shownPage === "dev" ? (
      <DevView
        load={loadDev}
        onAction={devAction}
        onOpenProject={(projectId) => navigate.toPluginPanel("mail", { subPath: projectSubPath(projectId) })}
        refreshKey={pageRefresh}
      />
    ) : shownPage === "projects" ? (
      <ProjectsView
        projectId={parseProjectSubPath(subPath)}
        loadProjects={loadProjectLists}
        loadMail={loadProjectMail}
        onSelectProject={(projectId) =>
          navigate.toPluginPanel("mail", { subPath: projectId === null ? pageSubPath("projects") : projectSubPath(projectId) })
        }
        onOpen={mailAi.onOpenConversation}
        onOpenInBb={(projectId) => navigate.toProject(projectId)}
        refreshKey={pageRefresh}
      />
    ) : undefined;

  // ---- Slice 3g: the BB integration ----

  const bbContext = useBbContext();
  const codeRenderers = useMemo<CodeRenderers>(
    () => ({
      renderCode: (content, path) => <HostSourceCode content={content} path={path} overflow="wrap" />,
      renderDiff: (patch, path) => <HostDiff patch={patch} path={path} overflow="wrap" />,
      copy: (text) => {
        void copy(text).then((done) => {
          if (done === false) toast.error(tx("Could not copy"));
        });
      },
    }),
    [copy],
  );
  const attachmentFolder = bbSettings.attachmentFolder !== "" ? bbSettings.attachmentFolder : "mail-attachments";
  const [ruleRuns, setRuleRuns] = useState<RuleRunView[]>([]);
  const loadRuleRuns = useCallback(async () => {
    try {
      const { runs } = await rpc.call("rule_runs_list", {});
      setRuleRuns(runs.filter((run) => run.state === "ready" || run.state === "capped" || run.state === "failed"));
    } catch {
      // The strip keeps what it showed.
    }
  }, [rpc]);
  useEffect(() => {
    if (status?.vaultReady !== true || !mailRulesOn) {
      setRuleRuns([]);
      return;
    }
    void loadRuleRuns();
  }, [loadRuleRuns, mailRulesOn, status?.vaultReady]);
  useDebouncedRealtime(DAY_NOTICE_CHANNEL, () => {
    if (mailRulesOn) void loadRuleRuns();
  });
  const pauseRules = useCallback(() => {
    rpc
      .call("rules_pause", {})
      .then(({ paused }) => {
        void loadRuleRuns();
        toast(paused === 1 ? tx("Paused 1 rule") : tx("Paused {paused} rules", { paused }), {
          action: {
            label: tx("Undo"),
            onClick: () => {
              rpc
                .call("rules_pause", { undo: true })
                .then(() => void loadRuleRuns())
                .catch((error: unknown) => toast.error(tx("Could not undo: {p1}", { p1: messageOf(error) })));
            },
          },
        });
      })
      .catch((error: unknown) => toast.error(tx("Could not pause the rules: {p1}", { p1: messageOf(error) })));
  }, [loadRuleRuns, rpc]);
  const mailBb = useMemo<MailBbPorts>(
    () => ({
      call: bbCall,
      renderers: codeRenderers,
      attachmentFolder,
      context: { projectId: bbContext.projectId, threadId: bbContext.threadId },
      notify: (text, action) => {
        toast(text, action !== undefined ? { action: { label: action.label, onClick: action.run } } : undefined);
      },
      notifyError: (text) => toast.error(text),
      onOpenThread: (bbThreadId) => navigate.toThread(bbThreadId),
      onOpenProject: (projectId) => navigate.toPluginPanel("mail", { subPath: projectSubPath(projectId) }),
      onEditInComposer: (projectId, prompt) => navigate.toCompose({ projectId, initialPrompt: prompt, focusPrompt: true }),
      onChanged: () => {
        const open = openThreadId.current;
        if (open !== null) void loadThread(open, null);
        if (mailRulesOn) void loadRuleRuns();
      },
      onOpenDev: () => navigate.toPluginPanel("mail", { subPath: pageSubPath("dev") }),
      devFilter: bbSettings.devNotifications,
      ...(mailRulesOn
        ? {
            ruleRuns,
            onDismissRun: (run: RuleRunView) => {
              rpc
                .call("rule_run_dismiss", { id: run.id })
                .then(() => void loadRuleRuns())
                .catch((error: unknown) => toast.error(tx("Could not dismiss: {p1}", { p1: messageOf(error) })));
            },
            onPauseRules: pauseRules,
          }
        : {}),
    }),
    [
      attachmentFolder,
      bbCall,
      bbContext.projectId,
      bbContext.threadId,
      bbSettings.devNotifications,
      codeRenderers,
      loadRuleRuns,
      loadThread,
      mailRulesOn,
      navigate,
      pauseRules,
      rpc,
      ruleRuns,
    ],
  );

  // ---- Slice 3h: search, older mail, saved searches, folders, labels, drag and Files ----

  searchAttachments.current = pluginSettings?.indexAttachmentText === true;
  const historyStepDays = (() => {
    const days = pluginSettings?.historyStepDays;
    return typeof days === "number" && Number.isInteger(days) && days >= 7 && days <= 365 ? days : 30;
  })();
  const gmailIds = useMemo(() => new Set(accounts.filter((a) => a.preset === "gmail").map((a) => a.id)), [accounts]);
  const accountName = useCallback(
    (accountId: string) => {
      const found = accounts.find((a) => a.id === accountId);
      return found === undefined ? tx("Account") : (found.displayName?.trim() || found.email);
    },
    [accounts],
  );
  /** Polls a server job until it settles; returns a stop function. */
  const pollJob = useCallback(
    (jobId: string, onPoll: (poll: RpcOut<"server_job_poll">) => void, onFail: (error: string) => void) => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = async () => {
        if (stopped) return;
        try {
          const poll = await rpc.call("server_job_poll", { jobId });
          if (stopped) return;
          onPoll(poll);
          if (poll.state === "running") timer = setTimeout(() => void tick(), JOB_POLL_MS);
        } catch (error) {
          if (!stopped) onFail(messageOf(error));
        }
      };
      void tick();
      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      };
    },
    [rpc],
  );
  const stopPolls = useRef(new Map<string, () => void>());
  useEffect(() => () => {
    for (const stop of stopPolls.current.values()) stop();
    stopPolls.current.clear();
  }, []);
  const watchJob = useCallback(
    (slot: string, jobId: string, onPoll: (poll: RpcOut<"server_job_poll">) => void, onFail: (error: string) => void) => {
      stopPolls.current.get(slot)?.();
      stopPolls.current.set(slot, pollJob(jobId, onPoll, onFail));
    },
    [pollJob],
  );

  // Server search (#35): its hits are stored as kept rows, so the local search shows them.
  const [serverSearch, setServerSearch] = useState<(ServerSearchState & { jobId: string | null }) | null>(null);
  const serverSearchRef = useRef(serverSearch);
  serverSearchRef.current = serverSearch;
  const followServerJob = useCallback(
    (query: string, jobId: string) => {
      watchJob(
        "server",
        jobId,
        (poll) => {
          const before = serverSearchRef.current;
          if (before === null || before.jobId !== jobId) return;
          const known = before.ids;
          const fresh = poll.messageIds.filter((id) => !known.has(id));
          setServerSearch({ ...before, job: poll, ids: fresh.length > 0 ? new Set([...known, ...fresh]) : known });
          if (fresh.length > 0 || poll.state !== "running") {
            const current = latest.current;
            if (current.search.query === query) void runSearch(query, current.searchAccount);
          }
        },
        (error) => setServerSearch((prev) => (prev !== null && prev.jobId === jobId ? { ...prev, error } : prev)),
      );
    },
    [runSearch, watchJob],
  );
  const startServerSearch = useCallback(
    async (query: string) => {
      setServerSearch({ query, job: null, localOnly: [], ids: new Set(), error: null, jobId: null });
      try {
        const started = await rpc.call("server_search_start", { query, accountId: latest.current.searchAccount });
        setServerSearch({ query, job: null, localOnly: started.localOnly, ids: new Set(), error: null, jobId: started.jobId });
        serverSearchRef.current = { query, job: null, localOnly: started.localOnly, ids: new Set(), error: null, jobId: started.jobId };
        followServerJob(query, started.jobId);
      } catch (error) {
        setServerSearch({ query, job: null, localOnly: [], ids: new Set(), error: messageOf(error), jobId: null });
      }
    },
    [followServerJob, rpc],
  );
  const cancelServerSearch = useCallback(async () => {
    const jobId = serverSearchRef.current?.jobId ?? null;
    if (jobId === null) return;
    try {
      await rpc.call("server_job_cancel", { jobId });
    } catch (error) {
      toast.error(tx("Could not stop the search: {p1}", { p1: messageOf(error) }));
    }
  }, [rpc]);
  const moreFromServer = useCallback(async () => {
    const current = serverSearchRef.current;
    if (current === null || current.jobId === null) return;
    try {
      const { ok } = await rpc.call("server_search_more", { jobId: current.jobId });
      if (!ok) {
        toast(tx("Nothing more on the server"));
        return;
      }
      followServerJob(current.query, current.jobId);
    } catch (error) {
      toast.error(tx("Could not search further: {p1}", { p1: messageOf(error) }));
    }
  }, [followServerJob, rpc]);

  // Saved searches (#63).
  const [savedSearches, setSavedSearches] = useState<SavedSearchView[] | null>(null);
  const savedLoadedAt = useRef(0);
  const loadSavedSearches = useCallback(async () => {
    savedLoadedAt.current = Date.now();
    try {
      setSavedSearches((await rpc.call("saved_searches_list", {})).searches);
    } catch {
      setSavedSearches((prev) => prev ?? []);
    }
  }, [rpc]);
  useEffect(() => {
    if (status?.vaultReady !== true || accountIds === "") return;
    void loadSavedSearches();
  }, [accountIds, loadSavedSearches, status?.vaultReady]);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, () => {
    // Counts follow new mail at most once per 30 seconds.
    if (Date.now() - savedLoadedAt.current >= SAVED_REFRESH_MS) void loadSavedSearches();
  });
  const savedRouteId = parseSavedSearchSubPath(subPath);
  const savedRoute = savedRouteId === null || savedSearches === null ? null : (savedSearches.find((s) => s.id === savedRouteId) ?? "missing");
  const appliedSaved = useRef<string | null>(null);
  useEffect(() => {
    if (savedRoute === null || savedRoute === "missing" || status?.vaultReady !== true) {
      if (savedRouteId === null) appliedSaved.current = null;
      return;
    }
    const key = `${savedRoute.id}\n${savedRoute.query}`;
    if (appliedSaved.current === key) return;
    appliedSaved.current = key;
    void runSearch(savedRoute.query, savedRoute.accountId ?? latest.current.searchAccount);
  }, [savedRoute, savedRouteId, runSearch, status?.vaultReady]);
  const [savedEdit, setSavedEdit] = useState<SavedSearchEdit | null>(null);
  const saveSavedSearch = useCallback(
    async (input: { id?: string; name: string; query: string; accountId: string | null }) => {
      const { id } = await rpc.call("saved_search_save", input);
      setSavedEdit(null);
      await loadSavedSearches();
      if (input.id === undefined) toast(tx("Saved \u201c{name}\u201d", { name: input.name }));
      if (latest.current.subPath === savedSearchSubPath(id)) {
        appliedSaved.current = null;
      }
    },
    [loadSavedSearches, rpc],
  );
  const savedCommand = useCallback(
    async (kind: "saved_rename" | "saved_edit" | "saved_delete" | "saved_up" | "saved_down", id: string) => {
      const list = savedSearches ?? [];
      const at = list.findIndex((s) => s.id === id);
      const search = list[at];
      if (search === undefined) return;
      if (kind === "saved_rename" || kind === "saved_edit") {
        setSavedEdit({ kind: kind === "saved_rename" ? "rename" : "edit", search });
        return;
      }
      try {
        if (kind === "saved_delete") {
          await rpc.call("saved_search_delete", { id });
          toast(tx("Deleted \u201c{name}\u201d", { name: search.name }));
        } else {
          await rpc.call("saved_search_move", { id, position: Math.max(0, Math.min(list.length - 1, at + (kind === "saved_up" ? -1 : 1))) });
        }
      } catch (error) {
        toast.error(messageOf(error));
      }
      void loadSavedSearches();
    },
    [loadSavedSearches, rpc, savedSearches],
  );
  const onSearchQuery = useCallback(
    (query: string) => {
      if (query === "" && parseSavedSearchSubPath(latest.current.subPath) !== null) {
        navigate.toPluginPanel("mail", { subPath: viewSubPath(latest.current.view) });
      }
      void runSearch(query, latest.current.searchAccount);
    },
    [navigate, runSearch],
  );

  // Older mail (#34) of the folder viewed.
  const [history, setHistory] = useState<{ key: string; state: HistoryState; jobId: string | null } | null>(null);
  const historyKey = view.kind === "folder" ? viewKey(view) : null;
  const historyHere = history !== null && history.key === historyKey ? history.state : { kind: "idle" as const, since: null, note: null };
  const loadHistory = useCallback(async () => {
    const current = latest.current.view;
    if (current.kind !== "folder") return;
    const key = viewKey(current);
    setHistory({ key, state: { kind: "running", fetched: 0, total: 0 }, jobId: null });
    try {
      const { jobId } = await rpc.call("history_load", { accountId: current.accountId, folder: current.path });
      setHistory({ key, state: { kind: "running", fetched: 0, total: 0 }, jobId });
      watchJob(
        "history",
        jobId,
        (poll) => {
          const row = poll.accounts[0];
          if (poll.state === "running") {
            setHistory({ key, state: { kind: "running", fetched: row?.fetched ?? 0, total: row?.found ?? 0 }, jobId });
            return;
          }
          const failed = poll.state === "failed" || row?.reason === "connection_failed" || row?.reason === "password_needed";
          setHistory({
            key,
            jobId: null,
            state: failed
              ? { kind: "failed", error: row?.reason === "password_needed" ? "The account needs its password again" : "Older mail could not be loaded" }
              : { kind: "idle", since: poll.historySince ?? null, note: emptyStepsNote(poll.emptySteps ?? 0) },
          });
          if (viewKey(latest.current.view) === key) void loadList(latest.current.view, "refresh");
        },
        (error) => setHistory({ key, state: { kind: "failed", error }, jobId: null }),
      );
    } catch (error) {
      setHistory({ key, state: { kind: "failed", error: messageOf(error) }, jobId: null });
    }
  }, [loadList, rpc, watchJob]);
  const stopHistory = useCallback(async () => {
    const jobId = history?.jobId ?? null;
    if (jobId === null) return;
    try {
      await rpc.call("server_job_cancel", { jobId });
    } catch (error) {
      toast.error(tx("Could not stop: {p1}", { p1: messageOf(error) }));
    }
  }, [history?.jobId, rpc]);
  const [forget, setForget] = useState<{ request: ForgetRequest; count: number | null; error: string | null } | null>(null);
  const askForget = useCallback(
    async (accountId: string, path: string) => {
      const name = latest.current.folders?.find((f) => f.accountId === accountId && f.path === path)?.name ?? path;
      const request = { accountId, folder: path, name };
      setForget({ request, count: null, error: null });
      try {
        const { count } = await rpc.call("history_forget_check", { accountId, folder: path });
        setForget((prev) => (prev?.request === request ? { ...prev, count } : prev));
      } catch (error) {
        setForget((prev) => (prev?.request === request ? { ...prev, error: messageOf(error) } : prev));
      }
    },
    [rpc],
  );

  // Folder management (#49).
  const [folderName, setFolderName] = useState<FolderNameRequest | null>(null);
  const [folderDelete, setFolderDelete] = useState<{ request: DeleteRequest; check: DeleteCheck | null; error: string | null } | null>(null);
  const reloadFolders = useCallback(() => {
    const key = latest.current.scopeKey;
    if (key !== null) void loadFolders(key);
  }, [loadFolders]);
  const foldersOfAccount = (accountId: string) => (latest.current.folders ?? []).filter((f) => f.accountId === accountId);
  const childNames = (accountId: string, parent: string | null) =>
    foldersOfAccount(accountId)
      .filter((f) =>
        parent === null
          ? !f.path.includes("/") && !f.path.includes(".")
          : f.path.startsWith(`${parent}/`) || f.path.startsWith(`${parent}.`),
      )
      .map((f) => f.name);
  const createFolder = useCallback(
    async (accountId: string, parent: string | null, name: string) => {
      const { path } = await rpc.call("folder_create", { accountId, parent, name });
      setFolderName(null);
      toast(tx("Created {name}", { name }));
      reloadFolders();
      void path;
    },
    [reloadFolders, rpc],
  );
  const renameFolder = useCallback(
    async (accountId: string, from: string, name: string) => {
      const { path } = await rpc.call("folder_rename", { accountId, path: from, name });
      setFolderName(null);
      toast(tx("Renamed to {name}", { name }));
      reloadFolders();
      const current = latest.current.view;
      if (current.kind === "folder" && current.accountId === accountId && current.path === from) {
        navigate.toPluginPanel("mail", { subPath: viewSubPath({ kind: "folder", accountId, path }) });
      }
    },
    [navigate, reloadFolders, rpc],
  );
  const askDelete = useCallback(
    async (accountId: string, path: string) => {
      const name = latest.current.folders?.find((f) => f.accountId === accountId && f.path === path)?.name ?? path;
      const request = { accountId, path, name };
      setFolderDelete({ request, check: null, error: null });
      try {
        const check = await rpc.call("folder_delete_check", { accountId, path });
        setFolderDelete((prev) => (prev?.request === request ? { ...prev, check } : prev));
      } catch (error) {
        setFolderDelete((prev) => (prev?.request === request ? { ...prev, error: messageOf(error) } : prev));
      }
    },
    [rpc],
  );
  const deleteFolder = useCallback(
    async (request: DeleteRequest, input: { moveToTrash: boolean; expectedMessages: number }) => {
      const { ok, moved } = await rpc.call("folder_delete", { accountId: request.accountId, path: request.path, ...input });
      if (!ok) throw new Error("The folder was not deleted");
      setFolderDelete(null);
      toast(moved > 0 ? tx("Moved {p1} to Trash and deleted {name}", { p1: plural(moved, "message", "messages"), name: request.name }) : tx("Deleted {name}", { name: request.name }));
      reloadFolders();
      const current = latest.current.view;
      if (current.kind === "folder" && current.accountId === request.accountId && current.path === request.path) {
        navigate.toPluginPanel("mail", { subPath: "" });
      }
    },
    [navigate, reloadFolders, rpc],
  );
  const setSubscribed = useCallback(
    async (accountId: string, path: string, subscribed: boolean) => {
      try {
        await rpc.call("folder_subscribe", { accountId, path, subscribed });
        reloadFolders();
      } catch (error) {
        toast.error(messageOf(error));
      }
    },
    [reloadFolders, rpc],
  );
  const setGrouping = useCallback(
    (accountId: string, path: string, grouping: boolean) => {
      const key = groupingKey({ kind: "folder", accountId, path });
      const next = new Set(ungroupedRef.current);
      if (grouping) next.delete(key);
      else next.add(key);
      ungroupedRef.current = next;
      setUngrouped(next);
      writeUngrouped(next);
      rpc.call("folder_prefs_set", { accountId, path, grouping }).catch(() => {});
      const current = latest.current.view;
      if (groupingKey(current) === key) void loadList(current, "reset");
    },
    [loadList, rpc],
  );

  // Gmail labels (#79).
  const [labelsAsk, setLabelsAsk] = useState<{
    request: LabelsRequest;
    accountId: string;
    messageIds: string[];
    labels: { name: string; path: string | null }[] | null;
    error: string | null;
  } | null>(null);
  const openLabels = useCallback(
    async (threadIds: string[]) => {
      const snapshot = latest.current.reading;
      const ctx: ViewContext = { view: latest.current.view, folders: latest.current.folders };
      const messages: MessageHeader[] = [];
      try {
        for (const threadId of threadIds.slice(0, ACTION_CHUNK)) {
          const accountOf =
            latest.current.list.threads.find((t) => t.id === threadId)?.accountId ??
            (snapshot.detail?.thread.id === threadId ? snapshot.detail.thread.accountId : null);
          const detail =
            snapshot.detail !== null && snapshot.detail.thread.id === threadId
              ? snapshot.detail
              : await rpc.call("thread_get", { threadId, folder: folderIn(ctx, accountOf) });
          messages.push(...detail.messages);
        }
      } catch (error) {
        toast.error(messageOf(error));
        return;
      }
      const accountIds = new Set(messages.map((m) => m.accountId));
      const accountId = messages[0]?.accountId;
      if (accountId === undefined || accountIds.size !== 1 || !gmailIds.has(accountId)) {
        toast.error(tx("Labels are for one Gmail account at a time"));
        return;
      }
      const byDedup = messages.slice(0, ACTION_CHUNK);
      const request: LabelsRequest = { count: byDedup.length, current: byDedup.map((m) => m.labels) };
      setLabelsAsk({ request, accountId, messageIds: byDedup.map((m) => m.id), labels: null, error: null });
      try {
        const { labels } = await rpc.call("labels_list", { accountId });
        setLabelsAsk((prev) => (prev?.request === request ? { ...prev, labels } : prev));
      } catch (error) {
        setLabelsAsk((prev) => (prev?.request === request ? { ...prev, error: messageOf(error) } : prev));
      }
    },
    [gmailIds, rpc],
  );
  const applyLabels = useCallback(
    async (change: { add: string[]; remove: string[] }) => {
      const ask = labelsAsk;
      if (ask === null) return;
      const undoId = crypto.randomUUID();
      const { changed } = await rpc.call("labels_change", { messageIds: ask.messageIds, ...change, undoId });
      setLabelsAsk(null);
      if (changed > 0) recordUndo(undoId, "labels", changed, null, true);
      else toast(tx("No label changed"));
      refreshAfterChange();
      const open = latest.current.reading.threadId;
      if (open !== null) void loadThread(open, null);
    },
    [labelsAsk, loadThread, recordUndo, refreshAfterChange, rpc],
  );

  // Drag to folders (#88).
  const [dragAccounts, setDragAccounts] = useState<string[] | null>(null);
  // Slice 3i (part B resolution 5): the page's successor for the dragged open conversation.
  const dragAdvance = useRef<(() => void) | null>(null);
  const onDragAccounts = useCallback((accountIds: string[] | null, advance?: (() => void) | null) => {
    setDragAccounts(accountIds);
    dragAdvance.current = accountIds === null ? null : (advance ?? null);
  }, []);
  const dropThreads = useCallback(
    (raw: string, target: { accountId: string | null; action: MessageAction; destination?: string; name: string }) => {
      setDragAccounts(null);
      const advance = dragAdvance.current;
      dragAdvance.current = null;
      const ids = readMovePayload(raw, PAGE_ID);
      if (ids === null) return;
      const threads = latest.current.list.threads.filter((t) => ids.includes(t.id));
      if (threads.length === 0) return;
      const refusal = dropRefusal(threads.reduce((sum, t) => sum + t.messageCount, 0));
      if (refusal !== null) {
        toast.error(refusal);
        return;
      }
      if (target.accountId !== null && threads.some((t) => t.accountId !== target.accountId)) {
        toast.error(tx("Move mail between folders of one account at a time"));
        return;
      }
      const current = latest.current.view;
      if (target.action === "move" && current.kind === "folder" && current.path === target.destination && current.accountId === target.accountId) return;
      void threadsAction(
        threads.map((t) => t.id),
        target.action,
        target.destination,
        advance,
      );
    },
    [threadsAction],
  );

  const railCommand = useCallback(
    (command: RailCommand) => {
      switch (command.kind) {
        case "folder_new": {
          const accountId = command.accountId;
          const parent = command.parent === null ? null : (foldersOfAccount(accountId).find((f) => f.path === command.parent) ?? null);
          setFolderName({
            kind: "create",
            accountId,
            accountLabel: accountName(accountId),
            parent: parent === null ? null : { path: parent.path, name: parent.name },
            siblings: childNames(accountId, command.parent),
          });
          return;
        }
        case "folder_rename": {
          const folder = foldersOfAccount(command.accountId).find((f) => f.path === command.path);
          if (folder === undefined) return;
          const cut = Math.max(folder.path.lastIndexOf("/"), folder.path.lastIndexOf("."));
          setFolderName({
            kind: "rename",
            accountId: command.accountId,
            path: folder.path,
            name: folder.name,
            siblings: childNames(command.accountId, cut > 0 ? folder.path.slice(0, cut) : null),
          });
          return;
        }
        case "folder_delete":
          void askDelete(command.accountId, command.path);
          return;
        case "folder_subscribe":
          void setSubscribed(command.accountId, command.path, command.subscribed);
          return;
        case "folder_grouping":
          setGrouping(command.accountId, command.path, command.grouping);
          return;
        case "history_forget":
          void askForget(command.accountId, command.path);
          return;
        case "saved_open":
          navigate.toPluginPanel("mail", { subPath: savedSearchSubPath(command.id) });
          return;
        case "drop": {
          const folder = foldersOfAccount(command.accountId).find((f) => f.path === command.path);
          if (folder === undefined) return;
          dropThreads(command.raw, { accountId: command.accountId, ...dropAction(folder), name: folder.name });
          return;
        }
        case "drop_role":
          dropThreads(command.raw, {
            accountId: null,
            action: command.role === "trash" ? "delete" : command.role === "junk" ? "spam" : "archive",
            name: command.role,
          });
          return;
        default:
          void savedCommand(command.kind, command.id);
      }
    },
    // foldersOfAccount and childNames read latest.current.
    [accountName, askDelete, askForget, dropThreads, navigate, savedCommand, setGrouping, setSubscribed],
  );

  // Files (#85).
  const loadFiles = useCallback(
    (filter: FilesFilter, cursor: string | null) => rpc.call("files_list", { ...filter, cursor, limit: FILES_PAGE }),
    [rpc],
  );
  const downloadPart = useCallback(
    async (messageId: string, partId: string) => {
      const request = { kind: "attachment", messageId, partId } as const;
      try {
        const ticket = await rpc.call("download_ticket", request);
        if ((await saveTicket(ticket)) === "started") return;
        anchorDownload(await rpc.call("download_ticket", request));
      } catch (error) {
        toast.error(tx("Could not download: {p1}", { p1: messageOf(error) }));
      }
    },
    [rpc],
  );
  const [filesFilter, setFilesFilter] = useState<{ filter: FilesFilter; serial: number }>({ filter: {}, serial: 0 });
  const filesContent =
    shownPage === "files" ? (
      <FilesView
        key={filesFilter.serial}
        accounts={accounts}
        load={loadFiles}
        initial={filesFilter.filter}
        viewable={(file) => viewerShows(file.kind, file.mimeType)}
        onView={(file) =>
          setViewing({ messageId: file.messageId, partId: file.partId, filename: file.filename, mimeType: file.mimeType, size: file.size, kind: file.kind })
        }
        onDownload={(file) => void downloadPart(file.messageId, file.partId)}
        onOpenMessage={(file) => navigate.toPluginPanel("mail", { subPath: threadSubPath(file.accountId, file.threadId) })}
      />
    ) : undefined;
  // Slice 3p: the Archive page. Mail read from files; nothing here touches a mailbox.
  const [archiveRefresh, setArchiveRefresh] = useState(0);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, (payloads) => {
    // An import or a removal in the terminal publishes with no account.
    if (payloads.some((payload) => (payload as { accountId?: unknown } | null)?.accountId == null)) setArchiveRefresh((n) => n + 1);
  });
  const archivePorts = useMemo<ArchivePorts>(
    () => ({
      archives: async () => (await rpc.call("archives_list", {})).archives,
      messages: (archiveId, query, cursor) => rpc.call("archive_messages", { archiveId, query, cursor }),
      message: (id) => rpc.call("archive_message", { id }),
      download: async (id, partId) => {
        const request = { id, partId };
        const ticket = await rpc.call("archive_download_ticket", request);
        if ((await saveTicket(ticket)) === "started") return;
        // A ticket works once: the fallback takes a fresh one.
        anchorDownload(await rpc.call("archive_download_ticket", request));
      },
      remove: async (id) => {
        await rpc.call("archive_remove", { id });
      },
    }),
    [rpc],
  );
  const archiveContent =
    shownPage === "archive" ? <ArchiveViewPage ports={archivePorts} onOpenLink={openLink} refresh={archiveRefresh} /> : undefined;
  const shownContent = pageContent ?? filesContent ?? archiveContent ?? settingsContent;

  // Reading (#50, #54, #62, #83, #86, #89).
  const codeTheme = experimental_useCodeTheme();
  const [viewing, setViewing] = useState<ViewRequest | null>(null);
  const pdfEngine = useMemo(() => browserPdfEngine(), []);
  const viewerHost = useMemo<ViewerHost>(
    () => ({
      getTicket: (request) => rpc.call("attachment_view_ticket", { messageId: request.messageId, partId: request.partId }),
      fetch: (url) => fetch(url, { credentials: "same-origin", cache: "no-store" }),
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      renderCode: (content, path) => <HostSourceCode content={content} path={path} overflow="wrap" />,
      Lightbox: HostImageLightbox,
      pdf: pdfEngine,
    }),
    [pdfEngine, rpc],
  );
  const loadRelated = useCallback(async (messageId: string) => (await rpc.call("related_messages", { messageId })).hits, [rpc]);
  const [conversationJob, setConversationJob] = useState<{ threadId: string; state: "running" | "done"; note: string | null } | null>(null);
  const loadConversation = useCallback(async () => {
    const threadId = latest.current.reading.threadId;
    if (threadId === null) return;
    setConversationJob({ threadId, state: "running", note: null });
    try {
      const { jobId } = await rpc.call("conversation_load", { threadId });
      watchJob(
        "conversation",
        jobId,
        (poll) => {
          if (poll.state === "running") return;
          const fetched = poll.accounts.reduce((sum, row) => sum + row.fetched, 0);
          const note =
            poll.state === "failed"
              ? tx("The conversation could not be loaded")
              : poll.state === "cancelled"
                ? tx("Stopped")
                : fetched === 0
                  ? tx("Nothing more of this conversation on the server")
                  : tx("Loaded {p1} from the server", { p1: plural(fetched, "message", "messages") });
          setConversationJob({ threadId, state: "done", note });
          if (latest.current.reading.threadId === threadId) void loadThread(threadId, null);
        },
        (error) => setConversationJob({ threadId, state: "done", note: error }),
      );
    } catch (error) {
      setConversationJob({ threadId, state: "done", note: messageOf(error) });
    }
  }, [loadThread, rpc, watchJob]);
  const printMessages = useCallback(
    async (messages: readonly MessageHeader[]) => {
      if (messages.length === 0) return;
      const bodies = latest.current.reading.bodies;
      let printable: PrintMessage[];
      try {
        printable = await Promise.all(
          messages.map(async (message) => {
            const known = bodies[message.id];
            const body = known?.status === "ready" ? known.body : await rpc.call("message_body", { messageId: message.id });
            return { header: message, body };
          }),
        );
      } catch (error) {
        toast.error(tx("Could not prepare the page: {p1}", { p1: messageOf(error) }));
        return;
      }
      const subject = messages[0]!.subject;
      const html = printDocument(printable, subject, { cleanLinks: cleanLinksOn.current });
      if (await printHtml(html)) return;
      const save = () => {
        const fileName = printFileName(new Date(), subject);
        void experimental_saveFile({ fileName, blob: new Blob([html], { type: "text/html" }) }).catch(() => {
          toast.error(tx("The page could not be saved"));
        });
      };
      toast(tx("Printing is not available here"), { action: { label: tx("Save printable page"), onClick: save } });
    },
    [rpc],
  );

  const slice3hPorts: MailSlice3hPorts = {
    pageId: PAGE_ID,
    onOpenFiles: (filter) => {
      setFilesFilter((prev) => ({ filter: filter ?? {}, serial: prev.serial + 1 }));
      navigate.toPluginPanel("mail", { subPath: pageSubPath("files") });
    },
    onSaveSearch: (query) => setSavedEdit({ kind: "save", query, accountId: searchAccount }),
    server: serverSearch,
    onServerSearch: (query) => void startServerSearch(query),
    onServerCancel: () => void cancelServerSearch(),
    onServerMore: () => void moreFromServer(),
    onSearchMore: () => void searchMore(),
    savedSearch:
      savedRoute === null
        ? null
        : savedRoute === "missing"
          ? "missing"
          : { name: savedRoute.name, query: savedRoute.query, onEdit: () => setSavedEdit({ kind: "edit", search: savedRoute }) },
    history: historyKey === null ? null : historyHere,
    historyStepDays,
    onLoadHistory: () => void loadHistory(),
    onStopHistory: () => void stopHistory(),
    onDragAccounts,
    onLabels: (threadIds) => void openLabels(threadIds),
    gmail: (accountId) => gmailIds.has(accountId),
    reading: {
      // Slice 3k: OpenPGP in a message. What pgp_open returns stays in the panel's state.
      pgp: {
        open: (messageId) => rpc.call("pgp_open", { messageId }),
        verify: (messageId) => rpc.call("pgp_verify", { messageId }),
        importFromMessage: async (messageId) => (await rpc.call("pgp_cert_import_message", { messageId })).added.length,
      },
      // Slice 3l: a calendar invitation. The answer is queued like any send and keeps its Undo.
      invite: {
        view: (messageId) => rpc.call("invite_view", { messageId }),
        reply: async (messageId, answer) => {
          const queued = await rpc.call("invite_reply", { messageId, answer, requestId: crypto.randomUUID() });
          showUndo(queued.outboxId, queued.sendAfter, "owner", "invite_reply");
          void loadOutbox();
        },
      },
      // AI writes mail: the reply drafted for a message. Use opens an ordinary reply with the text in it.
      replyDraft: {
        version: mailVersion,
        get: async (messageId) => (await rpc.call("reply_draft_get", { messageId })).draft,
        use: async (messageId, paragraphs) => {
          const prepared = await rpc.call("compose_prepare", { kind: "reply", messageId });
          const { draft } = await rpc.call("compose_open", { draftId: prepared.draftId });
          openComposer(draft, prepared.warning, prepared.dropped, latest.current.reading.threadId, paragraphs);
        },
        dismiss: async (messageId) => {
          await rpc.call("reply_draft_dismiss", { messageId });
        },
      },
      viewable: (attachment) => viewerShows(attachment.kind, attachment.mimeType),
      onView: (_message, attachment) =>
        setViewing({
          messageId: _message.id,
          partId: attachment.partId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          kind: attachment.kind,
        }),
      loadSenderCard: (address, accountId) => rpc.call("sender_card", { address, accountId }),
      mailView: readingSettings.mailView,
      dark: codeTheme.mode === "dark" && readingSettings.darkMail === "adapt",
      hideQuotes: readingSettings.hideQuotes,
      cleanLinks: readingSettings.cleanLinks,
      onPrint: (messages) => void printMessages(messages),
      conversation: {
        state: conversationJob !== null && conversationJob.threadId === reading.threadId ? conversationJob.state : "idle",
        note: conversationJob !== null && conversationJob.threadId === reading.threadId ? conversationJob.note : null,
        onLoad: () => void loadConversation(),
      },
      related: {
        load: loadRelated,
        onOpen: (hit) => navigate.toPluginPanel("mail", { subPath: threadSubPath(hit.summary.accountId, hit.summary.threadId) }),
      },
    },
  };
  const slice3hDialogs = (
    <>
      <SaveSearchDialog request={savedEdit} onSave={saveSavedSearch} onCancel={() => setSavedEdit(null)} />
      <FolderNameDialog request={folderName} onCreate={createFolder} onRename={renameFolder} onCancel={() => setFolderName(null)} />
      <DeleteFolderDialog
        request={folderDelete?.request ?? null}
        check={folderDelete?.check ?? null}
        checkError={folderDelete?.error ?? null}
        onDelete={(input) => (folderDelete === null ? Promise.resolve() : deleteFolder(folderDelete.request, input))}
        onCancel={() => setFolderDelete(null)}
      />
      <HistoryForgetDialog
        request={forget?.request ?? null}
        count={forget?.count ?? null}
        error={forget?.error ?? null}
        onConfirm={async () => {
          if (forget === null) return;
          const { removed } = await rpc.call("history_forget", { accountId: forget.request.accountId, folder: forget.request.folder });
          setForget(null);
          toast(tx("Removed {p1} from Mail", { p1: plural(removed, "older message", "older messages") }));
          setHistory(null);
          refreshAfterChange();
        }}
        onCancel={() => setForget(null)}
      />
      <AttachmentViewer
        request={viewing}
        host={viewerHost}
        onDownload={(request) => void downloadPart(request.messageId, request.partId)}
        onOpenLink={openLink}
        onClose={() => setViewing(null)}
      />
      <LabelsDialog
        request={labelsAsk?.request ?? null}
        labels={labelsAsk?.labels ?? null}
        loadError={labelsAsk?.error ?? null}
        onApply={applyLabels}
        onCancel={() => setLabelsAsk(null)}
      />
    </>
  );

  // ---- The sidebar's rail ----

  const outboxInScope = useMemo(
    () => outbox.filter((row) => unified || row.accountId === account?.id),
    [account?.id, outbox, unified],
  );
  const sidebarState = useMemo<MailSidebarState | null>(
    () =>
      status === null
        ? null
        : {
            vaultReady: status.vaultReady,
            accounts: status.accounts,
            unified,
            account,
            folders,
            roles: scoped?.roles ?? [],
            foldersError: scoped?.error ?? null,
            view,
            outbox: outboxInScope,
            pages: {
              today: pageCounts.today,
              tasks: pageCounts.tasks,
              current: shownPage === "settings" ? null : shownPage,
              ...(bbSettings.devNotifications ? { dev: pageCounts.dev } : {}),
              projects: true,
              files: true,
              archive: true,
            },
            saved: { searches: savedSearches ?? [], currentId: savedRouteId },
            grouped: (accountId: string, path: string) => !ungrouped.has(groupingKey({ kind: "folder", accountId, path })),
            dragAccounts,
            gmailAccounts: [...gmailIds],
          },
    // currentViewKey stands for view, which is a new object each render.
    [status, unified, account, folders, scoped, currentViewKey, outboxInScope, pageCounts, shownPage, bbSettings.devNotifications, savedSearches, savedRouteId, ungrouped, dragAccounts, gmailIds],
  );
  /** Changes when a pick in the sidebar should bring focus to the page. */
  const [focusRequest, setFocusRequest] = useState(0);
  const onCommand = useRef<(command: PageCommand) => void>(() => {});
  onCommand.current = (command) => {
    switch (command.kind) {
      case "compose":
        void compose();
        return;
      case "account":
        selectAccount(command.choice);
        setFocusRequest((n) => n + 1);
        return;
      case "view":
        selectView(command.view);
        setFocusRequest((n) => n + 1);
        return;
      case "settings":
        openSettings();
        return;
      case "thread":
        navigate.toPluginPanel("mail", { subPath: threadSubPath(command.link.accountId, command.link.threadId) });
        return;
      case "page":
        navigate.toPluginPanel("mail", { subPath: pageSubPath(command.page) });
        return;
      case "rail":
        railCommand(command.command);
        return;
    }
  };
  const sidebarLink = useRef<ReturnType<typeof mailPageLink.register> | null>(null);
  useEffect(() => {
    const link = mailPageLink.register((command) => onCommand.current(command));
    sidebarLink.current = link;
    return () => {
      sidebarLink.current = null;
      link.unregister();
    };
  }, []);
  useEffect(() => {
    sidebarLink.current?.publish(sidebarState);
  }, [sidebarState]);

  return (
    <>
    <MailPage
      translation={readingTranslation}
      focusRequest={focusRequest}
      status={status}
      statusError={statusError}
      account={account}
      unified={unified}
      onSelectAccount={selectAccount}
      folders={folders}
      view={view}
      onSelectView={selectView}
      list={list}
      onLoadMore={() => {
        if (scopeKey !== null) void loadList(view, "more");
      }}
      search={search}
      onSearch={onSearchQuery}
      syncing={syncing}
      bbLink={bbLink}
      density={pluginSettings?.listDensity === "compact" ? "compact" : "comfortable"}
      readingPane={pluginSettings?.readingPane === "bottom" ? "bottom" : "right"}
      onSync={() => void sync()}
      reading={reading}
      onSelectThread={(threadId, messageId, accountId) => {
        wantedLink.current = null;
        selectThread(threadId, messageId, accountId);
      }}
      onCloseThread={closeThread}
      onToggleMessage={toggleMessage}
      onOpenLink={openLink}
      onHandToAgent={(message) => void handToAgent(message)}
      selection={selection}
      onSelectionChange={setSelection}
      onThreadsAction={(ids, action, destination, then) => void threadsAction(ids, action, destination, then)}
      actionPending={actionPending}
      onToggleThreadFlag={(threadId) => void toggleThreadFlag(threadId)}
      onToggleMessageFlag={(message) => void toggleMessageFlag(message)}
      details={details}
      onOpenDetails={(message) => void openDetails(message)}
      onCloseDetails={closeDetails}
      onCheckSender={checkSenderAgain}
      onCopy={copy}
      onDownloadEml={(message) => void download(message, null)}
      onDownloadAttachment={(message, attachment) => void download(message, attachment)}
      onShowImages={showImages}
      onAlwaysShowImages={(message) => void alwaysShowImages(message)}
      onStopImages={(message) => void stopImages(message)}
      accountForm={accountForm}
      onOpenAccountForm={setAccountForm}
      onRetrySignIn={retrySignIn}
      onGoogleSignIn={googleSignIn}
      onCloseAccountForm={() => setAccountForm(null)}
      onTestAccount={testAccount}
      onSaveAccount={saveAccount}
      ExternalLink={UrlLink}
      composer={mailComposer}
      composerPorts={composerPorts}
      onCompose={() => void compose()}
      onReply={(kind, message) => void reply(kind, message)}
      onEditDraft={(message) => void editDraft(message)}
      onEditDraftThread={(threadId, accountId) => void editDraftThread(threadId, accountId)}
      onCloseComposer={closeComposer}
      onSent={sent}
      outbox={outbox}
      outboxPending={outboxPending}
      onOutboxAction={(row, action) => void outboxAction(row.id, action)}
      smtpAccountId={smtpAccountId}
      onOpenSmtp={setSmtpAccountId}
      onCloseSmtp={() => setSmtpAccountId(null)}
      onTestSmtp={(input) => smtpCall("accounts_smtp_test", input)}
      onSaveSmtp={(input) => smtpCall("accounts_smtp_set", input)}
      identities={identities}
      templates={templates}
      onManageTemplates={() => openSettings("templates")}
      onUndo={() => void undo(lastUndo.current?.id ?? null, lastUndo.current?.moving ?? false)}
      listFilter={listFilter}
      onListFilter={setListFilter}
      tabs={tabPorts}
      typing={typing}
      inbox={inboxPorts}
      ai={mailAi}
      bb={mailBb}
      slice3h={slice3hPorts}
      {...(shownContent !== undefined ? { page: shownContent, pageWide: settingsContent !== undefined } : {})}
    />
    <LinkDialog
      link={linkAsk}
      onOpen={(link) => {
        setLinkAsk(null);
        goToUrl(link.url);
      }}
      onCancel={() => setLinkAsk(null)}
    />
    <UnsubscribeDialog
      request={unsubscribeAsk === null ? null : { info: unsubscribeAsk.info, method: unsubscribeAsk.method }}
      fromAddress={accounts.find((a) => a.id === unsubscribeAsk?.message.accountId)?.email ?? "your address"}
      onConfirm={(method) => {
        const ask = unsubscribeAsk;
        setUnsubscribeAsk(null);
        if (ask !== null) void runUnsubscribe(ask.message, ask.info, method);
      }}
      onCancel={() => setUnsubscribeAsk(null)}
    />
    <SnoozeFolderDialog
      request={folderRequest}
      folders={askFolders}
      onCreate={async (accountId) => {
        await rpc.call("snooze_folder_create", { accountId });
        folderSettled();
      }}
      onUse={async (accountId, path) => {
        await rpc.call("snooze_folder_use", { accountId, path });
        folderSettled();
      }}
      onCancel={() => setFolderAsk(null)}
    />
    <SnoozeFolderDialog
      request={settingsFolder}
      folders={settingsFolders}
      onCreate={async (accountId) => {
        await rpc.call("snooze_folder_create", { accountId });
        setSettingsFolder(null);
        void loadStatus();
      }}
      onUse={async (accountId, path) => {
        await rpc.call("snooze_folder_use", { accountId, path });
        setSettingsFolder(null);
        void loadStatus();
      }}
      onCancel={() => setSettingsFolder(null)}
    />
    <TranslationSettings
      open={translateSettingsOpen}
      onOpenChange={translateSettingsChanged}
      load={loadTranslateSettings}
      save={saveTranslateSettings}
      clear={clearTranslations}
      onSaved={translateSettingsSaved}
    />
    {slice3hDialogs}
    </>
  );
}

/** One account's folders, for a folder picker; null while they load (or with no account). */
function useAccountFolders(accountId: string | null): Folder[] | null {
  const rpc = useRpc<typeof rpcContract>();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  useEffect(() => {
    setFolders(null);
    if (accountId === null) return;
    let live = true;
    rpc.call("folders_list", { accountId }).then(
      ({ folders: listed }) => {
        if (live) setFolders(listed);
      },
      () => {
        if (live) setFolders([]);
      },
    );
    return () => {
      live = false;
    };
  }, [accountId, rpc]);
  return folders;
}

// ---- New-mail toasts (slice 3e) ----

/** Tokens already toasted in this window: a repeated signal never stacks a second toast. */
const toastedTokens = new Set<string>();
const TOASTED_TOKENS_KEPT = 50;

function newMailToken(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { token } = payload as { token?: unknown };
  return typeof token === "string" && token !== "" && token.length <= 64 ? token : null;
}

type Navigate = ReturnType<typeof useBbNavigate>;

/** The senders behind a token as a toast with Open; any failure shows nothing. */
async function showNewMail(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  token: string,
  navigate: { current: Navigate | null },
): Promise<void> {
  try {
    const { items, more } = await rpc.call("new_mail_get", { token });
    const plan = newMailToastPlan(items, more, mailPageLink.showsInbox());
    if (plan === null) return;
    const subPath = threadSubPath(plan.open.accountId, plan.open.threadId);
    // Without BB's navigation (spec resolution 23), Open goes through a mounted Mail page, or is left out.
    const canOpen = navigate.current !== null || mailPageLink.mounted();
    const open = () => {
      try {
        if (navigate.current !== null) navigate.current.toPluginPanel("mail", { subPath });
        else mailPageLink.send({ kind: "thread", link: plan.open });
      } catch {
        // Nothing to open.
      }
    };
    toast(plan.title, {
      id: `makosh-mail-new-${token}`,
      description: plan.description,
      duration: NEW_MAIL_TOAST_MS,
      ...(canOpen ? { action: { label: tx("Open"), onClick: open } } : {}),
    });
  } catch {
    // Expired token, a refusal, or no toast host: the badge carries on.
  }
}

/**
 * New-mail toasts in every BB window (spec "Toast"): mounted inside the
 * badge hook, which the host runs whether or not the Mail page is open.
 * Every step is caught, so a toast failure never takes the badge with it
 * (spec resolution 23); navigate sits in a ref, outside the subscription.
 */
function useNewMailToasts(): void {
  const rpc = useRpc<typeof rpcContract>();
  let navigate: Navigate | null = null;
  try {
    navigate = useBbNavigate();
  } catch {
    navigate = null;
  }
  const navigateRef = useRef<Navigate | null>(navigate);
  navigateRef.current = navigate;
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useRealtime(NEW_MAIL_CHANNEL, (payload) => {
    try {
      const token = newMailToken(payload);
      if (token === null || toastedTokens.has(token)) return;
      toastedTokens.add(token);
      while (toastedTokens.size > TOASTED_TOKENS_KEPT) toastedTokens.delete(toastedTokens.values().next().value!);
      void showNewMail(rpcRef.current, token, navigateRef);
    } catch {
      // The badge carries on.
    }
  });
}

// ---- Day notices (slice 3f) ----

/** Tokens of day notices already asked for in this window. */
const dayNoticeTokens = new Set<string>();
/** Most notices one ask shows (each call hands the oldest unshown one). */
const DAY_NOTICES_PER_ASK = 3;

/** The waiting day notices as toasts with Open; any failure shows nothing. */
async function showDayNotices(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  token: string | null,
  navigate: { current: Navigate | null },
): Promise<void> {
  for (let shown = 0; shown < DAY_NOTICES_PER_ASK; shown++) {
    let notice: Awaited<ReturnType<typeof rpc.call<"day_notice_get">>>;
    try {
      notice = await rpc.call("day_notice_get", token !== null && shown === 0 ? { token } : {});
    } catch {
      // None waiting (not_found), a refusal, or no server: the badge carries on.
      return;
    }
    try {
      const plan = dayNoticePlan(notice);
      const target = plan.open;
      const subPath = "page" in target ? pageSubPath(target.page) : threadSubPath(target.accountId, target.threadId);
      const canOpen = navigate.current !== null || mailPageLink.mounted();
      const open = () => {
        try {
          if (navigate.current !== null) navigate.current.toPluginPanel("mail", { subPath });
          else if ("page" in target) mailPageLink.send({ kind: "page", page: target.page });
          else mailPageLink.send({ kind: "thread", link: target });
        } catch {
          // Nothing to open.
        }
      };
      toast(plan.title, {
        id: `makosh-mail-day-${token ?? "open"}-${shown}`,
        description: plan.description,
        duration: DAY_NOTICE_TOAST_MS,
        ...(canOpen ? { action: { label: tx("Open"), onClick: open } } : {}),
      });
    } catch {
      return;
    }
  }
}

/**
 * Today and reply-reminder toasts in every BB window (spec "Toasts"): the
 * badge hook subscribes to mail-day and asks once on mount, so a window
 * opened after the notice still shows it once (the server hands each notice
 * out once). Every step is caught (3e resolution 23).
 */
function useDayNotices(): void {
  const rpc = useRpc<typeof rpcContract>();
  let navigate: Navigate | null = null;
  try {
    navigate = useBbNavigate();
  } catch {
    navigate = null;
  }
  const navigateRef = useRef<Navigate | null>(navigate);
  navigateRef.current = navigate;
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useEffect(() => {
    try {
      void showDayNotices(rpcRef.current, null, navigateRef);
    } catch {
      // The badge carries on.
    }
  }, []);
  useRealtime(DAY_NOTICE_CHANNEL, (payload) => {
    try {
      const token = newMailToken(payload);
      if (token === null || dayNoticeTokens.has(token)) return;
      dayNoticeTokens.add(token);
      while (dayNoticeTokens.size > TOASTED_TOKENS_KEPT) dayNoticeTokens.delete(dayNoticeTokens.values().next().value!);
      void showDayNotices(rpcRef.current, token, navigateRef);
    } catch {
      // The badge carries on.
    }
  });
}

/** The nav entry's unread count, kept current by the same realtime signal. */
function useUnreadBadge(): ExperimentalBadge | null {
  const rpc = useRpc<typeof rpcContract>();
  useNewMailToasts();
  useDayNotices();
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    rpc.call("status_get", null).then(
      (status) => setCount(status.unreadCount),
      () => setCount(0),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, refresh);
  return count > 0 ? { count, label: tx("Unread mail") } : null;
}

/**
 * BB's sidebar while the Mail page is open: the mail rail in place of the
 * thread list. It draws what the page publishes and hands picks back to it.
 */
function MailFolderSidebar(_props: PluginNavPanelProps) {
  useMailLanguage();
  const navigate = useBbNavigate();
  const state = useSyncExternalStore(
    mailPageLink.subscribeSidebar,
    mailPageLink.sidebarState,
    mailPageLink.sidebarState,
  );
  return (
    <MailSidebar
      state={state}
      onCompose={() => void mailPageLink.send({ kind: "compose" })}
      onSelectAccount={(choice) => {
        if (!mailPageLink.send({ kind: "account", choice })) navigate.toPluginPanel("mail");
      }}
      onSelectView={(view) => {
        if (!mailPageLink.send({ kind: "view", view })) {
          navigate.toPluginPanel("mail", { subPath: viewSubPath(view) });
        }
      }}
      onOpenSettings={() => {
        if (!mailPageLink.send({ kind: "settings" })) navigate.toPluginPanel("mail", { subPath: settingsSubPath() });
      }}
      onSelectPage={(page) => {
        if (!mailPageLink.send({ kind: "page", page })) navigate.toPluginPanel("mail", { subPath: pageSubPath(page) });
      }}
      onRailCommand={(command) => {
        if (!mailPageLink.send({ kind: "rail", command }) && command.kind === "saved_open") {
          navigate.toPluginPanel("mail", { subPath: savedSearchSubPath(command.id) });
        }
      }}
    />
  );
}

// ---- Agent proposals (slice 3c) ----

/** The card's payload: the proposal id and content hash, nothing else (the server sets it). */
function proposalPayload(payload: unknown): { proposalId: string; contentHash: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { proposalId, contentHash } = payload as Record<string, unknown>;
  return typeof proposalId === "string" && typeof contentHash === "string" ? { proposalId, contentHash } : null;
}

/** The settled row's payload: `{ proposalId }`. */
function settledProposalId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { proposalId } = payload as Record<string, unknown>;
  return typeof proposalId === "string" && proposalId !== "" ? proposalId : null;
}

/**
 * The confirmation card in an agent's thread: a thin adapter that hands the
 * card its RPCs and the host's form. The submit value carries the proposal
 * id, the content hash and the view token of this card's own view.
 */
function AgentSendInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const form = experimental_useQuestionFormHost();
  const ids = proposalPayload(interaction.payload);
  const proposalId = ids?.proposalId ?? null;
  const contentHash = ids?.contentHash ?? null;
  const load = useCallback(async (): Promise<ProposalViewResult> => {
    if (proposalId === null || contentHash === null) return { state: "gone" };
    return rpc.call("proposal_view", { proposalId, contentHash });
  }, [contentHash, proposalId, rpc]);
  const registerAction = useCallback(
    (handler: (action: string) => boolean) => form.registerActionHandler(handler),
    [form],
  );
  if (ids === null) {
    return <AgentSendCard load={load} submit={async () => undefined} cancel={cancel} openDraft={() => undefined} />;
  }
  return (
    <AgentSendCard
      load={load}
      submit={(action, viewToken) => submit({ action, proposalId: ids.proposalId, contentHash: ids.contentHash, viewToken })}
      cancel={cancel}
      openDraft={(draftId) => navigate.toPluginPanel("mail", { subPath: draftSubPath(draftId) })}
      registerAction={registerAction}
    />
  );
}

/** A settled card's row in the thread: where the email stands now, with Undo while it waits. */
function AgentSendTimelineRow({ payload }: PluginTimelineRendererProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const proposalId = settledProposalId(payload);
  const [version, setVersion] = useState(0);
  useDebouncedRealtime(OUTBOX_CHANGED_CHANNEL, (payloads) => {
    if (payloads.some((p) => outboxEvent(p)?.id === proposalId)) setVersion((n) => n + 1);
  });
  const status = useCallback(async () => {
    if (proposalId === null) throw new Error("not_found");
    return rpc.call("proposal_status", { proposalId });
  }, [proposalId, rpc]);
  const outbox = useCallback(
    async (outboxId: string) => (await rpc.call("outbox_list", { accountId: null })).rows.find((r) => r.id === outboxId) ?? null,
    [rpc],
  );
  const undo = useCallback(async (outboxId: string) => (await rpc.call("outbox_cancel", { id: outboxId })).cancelled, [rpc]);
  return (
    <AgentSendRow
      status={status}
      outbox={outbox}
      undo={undo}
      openDraft={(draftId) => navigate.toPluginPanel("mail", { subPath: draftSubPath(draftId) })}
      version={version}
    />
  );
}

// ---- Agent triage (slice 3e) ----

/** The triage card's payload: the batch id and content hash, nothing else (the server sets it). */
function triagePayload(payload: unknown): { batchId: string; contentHash: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { batchId, contentHash } = payload as Record<string, unknown>;
  return typeof batchId === "string" && batchId !== "" && typeof contentHash === "string" ? { batchId, contentHash } : null;
}

/** The settled row's payload: `{ batchId }`. */
function settledBatchId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { batchId } = payload as Record<string, unknown>;
  return typeof batchId === "string" && batchId !== "" ? batchId : null;
}

/**
 * The inbox-actions card in an agent's thread: a thin adapter. The submit
 * value carries the batch id, the content hash, this view's token and the
 * ticked positions (under 2 KiB: at most 50 positions and a few accounts).
 */
function AgentTriageInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const form = experimental_useQuestionFormHost();
  const ids = triagePayload(interaction.payload);
  const batchId = ids?.batchId ?? null;
  const contentHash = ids?.contentHash ?? null;
  const load = useCallback(async (): Promise<TriageViewResult> => {
    if (batchId === null || contentHash === null) return { state: "gone" };
    return rpc.call("triage_view", { batchId, contentHash });
  }, [batchId, contentHash, rpc]);
  const registerAction = useCallback(
    (handler: (action: string) => boolean) => form.registerActionHandler(handler),
    [form],
  );
  return (
    <TriageCard
      load={load}
      submit={async (selection, viewToken) => {
        if (ids === null) return;
        await submit({
          action: "apply",
          batchId: ids.batchId,
          contentHash: ids.contentHash,
          viewToken,
          approved: selection.approved,
          createSnoozeFolder: selection.createSnoozeFolder,
        });
      }}
      cancel={cancel}
      registerAction={registerAction}
    />
  );
}

/** A settled triage card's row: what ran, with Undo while the batch's record lives. */
function AgentTriageTimelineRow({ payload }: PluginTimelineRendererProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const batchId = settledBatchId(payload);
  const [version, setVersion] = useState(0);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, () => setVersion((n) => n + 1));
  const status = useCallback(async () => {
    if (batchId === null) throw new Error("not_found");
    return rpc.call("triage_status", { batchId });
  }, [batchId, rpc]);
  const undo = useCallback(async () => {
    if (batchId === null) return tx("Nothing to undo");
    return undoResultText(await rpc.call("action_undo", { undoId: batchId }));
  }, [batchId, rpc]);
  return <TriageRow status={status} undo={undo} version={version} />;
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar, routed at
// /plugins/makosh-mail/mail; while it is open, BB's sidebar shows the mail
// rail instead of the thread list.
// ---- Slice 3g: BB surfaces (Email the result, Email this, the Mail Info section) ----

type Navigate3g = ReturnType<typeof useBbNavigate>;

/**
 * The RPC client and navigation the thread menu's useData publishes (BB
 * calls it once for the whole app); the message action, which gets neither,
 * reads them from here.
 */
const bbBridge: { rpc: ReturnType<typeof useRpc<typeof rpcContract>> | null; navigate: Navigate3g | null } = {
  rpc: null,
  navigate: null,
};

function useBbBridge(): typeof bbBridge {
  const rpc = useRpc<typeof rpcContract>();
  let navigate: Navigate3g | null = null;
  try {
    navigate = useBbNavigate();
  } catch {
    navigate = null;
  }
  bbBridge.rpc = rpc;
  bbBridge.navigate = navigate;
  return bbBridge;
}

/** A thread's result or one assistant message as a Mail draft (never sent), then Mail opens it. */
async function emailFromBb(
  bridge: typeof bbBridge,
  bbThreadId: string,
  source: { kind: "output" } | { kind: "message"; text: string },
): Promise<void> {
  const { rpc, navigate } = bridge;
  if (rpc === null) {
    toast.error(tx("Open Mail once, then try again"));
    return;
  }
  try {
    const { draftId, reply } = await rpc.call("draft_from_bb", { bbThreadId, source });
    toast.success(reply ? tx("Reply draft ready in Mail") : tx("Draft ready in Mail"));
    navigate?.toPluginPanel("mail", { subPath: draftSubPath(draftId) });
  } catch (error) {
    toast.error(tx("Could not make the draft: {p1}", { p1: messageOf(error) }));
  }
}

/** Email this: assistant messages only; the selected text when there is one. */
function emailMessageRun(context: Pick<PluginMessageActionContext, "threadId" | "message" | "selectedText">): Promise<void> | void {
  if (context.message.role !== "assistant") return;
  const selected = context.selectedText?.trim() ?? "";
  const text = selected !== "" ? selected : context.message.text;
  if (text.trim() === "") return;
  return emailFromBb(bbBridge, context.threadId, { kind: "message", text: text.slice(0, 100_000) });
}

/** The Mail section of a BB thread's Info tab: shown only when the project has bound or origin mail. */
function ThreadMailInfo({ threadId, projectId }: ExperimentalThreadInfoProps) {
  useMailLanguage();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("bb_thread_mail", { projectId, bbThreadId: threadId }), [projectId, rpc, threadId]);
  return (
    <ThreadMailSection
      load={load}
      onOpen={(accountId, mailThreadId) => navigate.toPluginPanel("mail", { subPath: threadSubPath(accountId, mailThreadId) })}
      onShowAll={() => navigate.toPluginPanel("mail", { subPath: projectSubPath(projectId) })}
      frame={(content, total) => (
        <HostInfoSection label={tx("Mail")} count={total}>
          {content}
        </HostInfoSection>
      )}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: tx("Mail"),
    icon: "Mail",
    path: "mail",
    component: MailPanel,
    experimental_sidebar: MailFolderSidebar,
    experimental_useBadge: useUnreadBadge,
  });
  // The confirmation card mail_propose opens (rendererId "agent-send"), and
  // its settled row in the thread timeline.
  app.slots.pendingInteraction({ id: "agent-send", component: AgentSendInteraction });
  app.slots.experimental_timelineRenderer({ kind: "makosh-mail/agent-send", component: AgentSendTimelineRow });
  // The inbox-actions card mail_triage opens (rendererId "agent-triage"), and its settled row.
  app.slots.pendingInteraction({ id: "agent-triage", component: AgentTriageInteraction });
  app.slots.experimental_timelineRenderer({ kind: "makosh-mail/agent-triage", component: AgentTriageTimelineRow });
  // Slice 3g (spec resolution 18): a thread's result or one assistant message as a Mail draft.
  app.slots.experimental_threadAction({
    id: "email-result",
    title: tx("Email the result"),
    icon: "Mail",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    placement: "menu",
    useData: useBbBridge,
    item: ({ thread, data }) => ({
      label: tx("Email the result"),
      icon: "Mail",
      run: () => emailFromBb(data, thread.id, { kind: "output" }),
    }),
  });
  app.slots.messageAction({ id: "email-message", title: tx("Email this"), icon: "Mail", run: emailMessageRun });
  app.slots.experimental_threadInfoSection({
    id: "mail",
    group: experimental_THREAD_INFO_SECTION_GROUPS.related,
    component: ThreadMailInfo,
  });
});
