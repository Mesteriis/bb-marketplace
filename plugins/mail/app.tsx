// Makosh Mail — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// This file is the BB adapter: it owns RPC, realtime refreshes, navigation and
// the composer, and hands plain data and callbacks to the host-agnostic page
// in src/ui.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_saveFile,
  experimental_useQuestionFormHost,
  UrlLink,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
  type PluginNavPanelProps,
  type PluginPendingInteractionProps,
  type PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import type {
  AttachmentMeta,
  DraftView,
  Folder,
  IdentityView,
  MAIL_CHANGED_CHANNEL as MailChangedChannel,
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
import { isRoleMoveAction, roleFolders } from "./src/core/actions.ts";
import type { ComposerPorts, ComposeWarningKind } from "./src/ui/composer.tsx";
import type { SmtpSettingsInput } from "./src/ui/smtp-dialog.tsx";
import type { DetailsState } from "./src/ui/details-panel.tsx";
import {
  DEFAULT_FOLDER_PATH,
  inboxPath,
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
  type ReadingState,
  type SearchState,
  type ThreadListState,
} from "./src/ui/mail-page.tsx";
import { outboxStateText, type OutboxAction } from "./src/ui/outbox.tsx";
import type { BodyState } from "./src/ui/reading-pane.tsx";
import { MailSidebar, type MailSidebarState } from "./src/ui/mail-sidebar.tsx";
import {
  draftSubPath,
  parseDraftSubPath,
  parseThreadSubPath,
  parseViewSubPath,
  viewSubPath,
  type ThreadLink,
} from "./src/ui/routes.ts";
import { AgentSendCard, type ProposalViewResult } from "./src/ui/agent-send-card.tsx";
import { AgentSendRow } from "./src/ui/agent-send-row.tsx";
import type { ReadingTranslation } from "./src/ui/reading-pane.tsx";
import {
  TRANSLATION_STARTING,
  TranslationBlock,
  type TranslationState,
} from "./src/ui/translation-block.tsx";
import { TranslationSettings } from "./src/ui/translation-settings.tsx";
import { MailSettings, type SettingsSection, type TemplateView } from "./src/ui/mail-settings.tsx";
import type { LanguageTag } from "./src/core/translate.ts";
import { subjectOrPlaceholder } from "./src/ui/thread-list.tsx";

// The channel name is checked against the core constant without importing it
// at runtime: a value import of the core would bundle its zod schemas.
const MAIL_CHANGED_CHANNEL: typeof MailChangedChannel = "mail-changed";
const OUTBOX_CHANGED_CHANNEL: typeof OutboxChangedChannel = "outbox-changed";
/** The Undo window when a row's sendAfter is not known yet. */
const UNDO_WINDOW_MS = 10_000;
/** How often a running translation is polled while the page is visible. */
const TRANSLATE_POLL_MS = 400;
const TRANSLATE_MISSING = "Translation needs the Makosh AI plugin";
const PAGE_SIZE = 50;
const MAX_PAGE = 100;
const SEARCH_LIMIT = 50;
const SYNC_INDICATOR_MS = 60_000;
/** message_action takes at most this many ids per call; larger batches go in sequence. */
const ACTION_CHUNK = 200;
/** thread_get calls in flight at once while a selection's messages are collected. */
const COLLECT_CONCURRENCY = 6;
/**
 * mail-changed events closer together than this cause one refresh: opening a
 * conversation with N unread messages publishes N of them.
 */
const REFRESH_DEBOUNCE_MS = 250;
/** A steady stream of events still refreshes at least this often. */
const REFRESH_MAX_WAIT_MS = 2_000;

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

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
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
  return `Help me with this email.\n\n${agentText}`;
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
  | { kind: "settings" };

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
    /** False when no page took the command. */
    send(command: PageCommand): boolean {
      const page = pages.at(-1);
      page?.onCommand(command);
      return page !== undefined;
    },
  };
})();

type FolderState = { key: string; folders: Folder[]; roles: RoleCount[]; error: string | null };

function MailPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();

  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
  const [accountForm, setAccountForm] = useState<AccountFormRequest>(null);
  const [mailComposer, setComposer] = useState<ComposerState | null>(null);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [outboxPending, setOutboxPending] = useState<ReadonlySet<string>>(new Set());
  const [smtpAccountId, setSmtpAccountId] = useState<string | null>(null);

  /**
   * The view the subPath names (a conversation link keeps the view before
   * it), and a counter of subPath changes.
   */
  const route = useRef({ subPath, serial: 0, view: parseViewSubPath(subPath) });
  if (route.current.subPath !== subPath) {
    route.current = {
      subPath,
      serial: route.current.serial + 1,
      view:
        parseThreadSubPath(subPath) !== null || parseDraftSubPath(subPath) !== null
          ? route.current.view
          : parseViewSubPath(subPath),
    };
  }
  const routeView = route.current.view;

  const accounts = status?.accounts ?? [];
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
  const searchAccount = unified ? null : (account?.id ?? null);

  // Latest values for callbacks that outlive a render (realtime, async results).
  const latest = useRef({ scopeKey, searchAccount, unified, view, folders, list, search, reading, selection, subPath });
  latest.current = { scopeKey, searchAccount, unified, view, folders, list, search, reading, selection, subPath };
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
  const requests = useRef({ list: 0, search: 0, thread: 0, folders: 0, details: 0 });
  const pendingRef = useRef(false);
  /** Stars being changed by the owner: a list refresh meanwhile keeps these values. */
  const flagIntents = useRef(new Map<string, boolean>());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusLoaded = useRef(false);

  /** A failed first load replaces the page; a failed refresh keeps the mailbox and toasts. */
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await rpc.call("status_get", null));
      statusLoaded.current = true;
      setStatusError(null);
    } catch (error) {
      if (statusLoaded.current) toast.error(`Could not refresh mail status: ${messageOf(error)}`);
      else setStatusError(messageOf(error));
    }
  }, [rpc]);

  /**
   * "reset" and "more" fetch one page; "refresh" re-fetches from the top, page
   * after page, until it has at least as many threads as are on screen.
   */
  const loadList = useCallback(
    async (forView: MailView, mode: "reset" | "refresh" | "more") => {
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
          const page = await rpc.call("threads_list", { scope: scopeOf(forView), cursor, limit });
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
          if (!same || prev.error === null) toast.error(`Could not load folders: ${text}`);
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
        const { hits } = await rpc.call("search", { query, accountId: forAccount, limit: SEARCH_LIMIT });
        if (token !== requests.current.search) return;
        setSearch({ query, hits, loading: false, error: null });
      } catch (error) {
        if (token !== requests.current.search) return;
        setSearch({ query, hits: [], loading: false, error: messageOf(error) });
      }
    },
    [rpc],
  );

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
        if (failure !== null) toast.error(`Could not mark the message read: ${failure}`);
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
            if (failure !== null) toast.error(`Could not mark the conversation read: ${failure}`);
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
    const link = wantedLink.current;
    if (link !== null) selectThread(link.threadId, null, link.accountId);
  }, [scopeKey, currentViewKey, loadList, runSearch, selectThread]);

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
    if (currentSearch.query !== "") void runSearch(currentSearch.query, forAccount);
  }, [loadFolders, loadList, runSearch]);

  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, (payloads) => {
    void loadStatus();
    const { scopeKey: key, unified: all, reading: currentReading } = latest.current;
    if (key === null) return;
    const touched = payloads.some((payload) => {
      const changed = changedAccount(payload);
      return changed === null || all || changed === key;
    });
    if (!touched) return;
    stopSyncing();
    refreshAfterChange();
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
      if (!sameView(next, current)) navigate.toPluginPanel("mail", { subPath: viewSubPath(next) });
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
    async (items: readonly ActionItem[], action: MessageAction, ctx: ViewContext, destination?: string) => {
      const failed = new Map<string, string>();
      const destinations = new Set<string>();
      let shortfall = 0;
      const source = sourceOf(ctx.view);
      const fail = (item: ActionItem, error: string) => {
        if (!failed.has(item.threadId)) failed.set(item.threadId, error);
      };
      for (let start = 0; start < items.length; start += ACTION_CHUNK) {
        const chunk = items.slice(start, start + ACTION_CHUNK);
        try {
          const { groups } = await rpc.call("message_action", {
            messageIds: chunk.map((item) => item.id),
            action,
            ...source,
            ...(destination !== undefined ? { destination } : {}),
          });
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
      return { failed, destinations, shortfall };
    },
    [rpc],
  );

  /**
   * An action on conversations' messages in the view: the selection bar, the
   * reading pane toolbar and the hotkeys. Failed conversations stay selected;
   * one toast per distinct error.
   */
  const threadsAction = useCallback(
    async (threadIds: string[], action: MessageAction, destination?: string) => {
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
        const { failed, destinations, shortfall } = await sendAction(items, action, ctx, destination);
        for (const [threadId, error] of collected.failures) failed.set(threadId, error);
        for (const error of new Set(failed.values())) toast.error(error);
        // Nothing of these in the view (or nothing to flag): not done, so they stay selected.
        const empty = threadIds.filter((id) => !failed.has(id) && !items.some((item) => item.threadId === id));
        if (empty.length > 0) {
          toast.error(`${plural(empty.length, "conversation", "conversations")} had nothing to change here`);
        }
        if (shortfall > 0) toast.error(`${plural(shortfall, "message", "messages")} had nothing to change here`);
        const done = new Set(threadIds.filter((id) => !failed.has(id) && !empty.includes(id)));
        if (moving && done.size > 0 && destinations.size > 0) {
          toast.success(`Moved to ${[...destinations].join(", ")}`);
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
          if (open !== null && done.has(open)) closeThread();
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
    [closeThread, collect, refreshAfterChange, sendAction],
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
        const { failed } = await sendAction(targets, action, ctx);
        const error = failed.get(threadId);
        if (error !== undefined) throw new Error(error);
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
    [collect, sendAction, setThreadFlagged],
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
        const { groups } = await rpc.call("message_action", {
          messageIds: [message.id],
          action: next ? "flag" : "unflag",
          folder: message.folder,
        });
        const refused = groups.find((g) => g.error !== null);
        if (refused !== undefined) throw new Error(refused.error!);
      } catch (error) {
        setFlag(!next);
        toast.error(messageOf(error));
      }
    },
    [rpc],
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
        toast.error(`Could not allow images: ${messageOf(error)}`);
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
        toast.error(`Could not stop showing images: ${messageOf(error)}`);
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
        toast.error(`Could not download: ${messageOf(error)}`);
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
      toast.error(`Sync failed: ${messageOf(error)}`);
    }
  }, [rpc, scopeKey, searchAccount, stopSyncing]);

  const openLink = useCallback(
    (url: string) => {
      if (!navigate.openUrl(url)) toast.error("This link cannot be opened here.");
    },
    [navigate],
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
            { provider: "mail", id: message.id, label: subjectOrPlaceholder(message.subject) },
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
        toast.error(`Could not hand the message to an agent: ${messageOf(error)}`);
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
    (draft: DraftView, warning: ComposeWarningKind, dropped: string[], dockThreadId: string | null) => {
      setComposer({ draft, warning, dropped, dockThreadId });
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
      (error: unknown) => toast.error(`Could not open the draft: ${messageOf(error)}`),
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
      toast.error(`Could not start a message: ${messageOf(error)}`);
    }
  }, [account, accounts, openComposer, rpc]);

  const reply = useCallback(
    async (kind: ComposeKind, message: MessageHeader) => {
      try {
        const prepared = await rpc.call("compose_prepare", { kind, messageId: message.id });
        const { draft } = await rpc.call("compose_open", { draftId: prepared.draftId });
        openComposer(draft, prepared.warning, prepared.dropped, latest.current.reading.threadId);
      } catch (error) {
        toast.error(`Could not start the ${kind === "forward" ? "forward" : "reply"}: ${messageOf(error)}`);
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
        toast.error(`Could not open the draft: ${messageOf(error)}`);
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
        toast.error(`Could not open the draft: ${messageOf(error)}`);
      }
    },
    [editDraft, rpc],
  );

  const composerPorts = useMemo<ComposerPorts>(
    () => ({
      save: (input) => rpc.call("compose_save", input),
      send: (input) => rpc.call("compose_send", input),
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
        toast.error(`Could not undo: ${messageOf(error)}`, { id: toastId });
      }
    },
    [loadOutbox, openComposer, rpc],
  );

  /** "Sending in N s · Undo" for a queued send, on every queued event. */
  const showUndo = useCallback(
    (outboxId: string, sendAfter: string | null, origin: OutboxRow["origin"] = "owner") => {
      const due = sendAfter === null ? NaN : Date.parse(sendAfter);
      const left = Number.isNaN(due) ? UNDO_WINDOW_MS : Math.max(0, due - Date.now());
      const label = origin === "agent" ? "Agent message · " : "";
      toast(`${label}Sending in ${Math.max(1, Math.ceil(left / 1000))} s`, {
        id: sendToastId(outboxId),
        duration: left + 2_000,
        action: { label: "Undo", onClick: () => void undoSend(outboxId) },
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
      for (const row of rows ?? []) if (row.state === "queued") showUndo(row.id, row.sendAfter, row.origin);
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
            showUndo(event.id, row?.sendAfter ?? null, row?.origin);
            break;
          case "sending":
          case "cancelled":
            toast.dismiss(toastId);
            break;
          case "done":
            toast.success("Sent", { id: toastId });
            break;
          case "failed":
            toast.error(row !== null ? outboxStateText(row) : "Not sent", {
              id: toastId,
              action: { label: "Retry", onClick: () => void outboxAction(event.id, "retry") },
            });
            break;
          case "unknown":
            toast.error("May have been sent — see the Outbox in Sent", { id: toastId });
            break;
          case "sent_no_copy":
            toast.error(row !== null ? outboxStateText(row) : "Sent; the copy to Sent failed", { id: toastId });
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
            toast.error(`Could not start the translation: ${messageOf(error)}`);
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

  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({
    open: false,
    section: "addresses",
  });
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
  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettings({ open: true, section });
      void loadIdentities();
      void loadTemplates();
    },
    [loadIdentities, loadTemplates],
  );
  const settingsDialog = (
    <MailSettings
      open={settings.open}
      section={settings.section}
      onOpenChange={(open) => setSettings((prev) => ({ ...prev, open }))}
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
      onOpenSmtp={(accountId) => {
        setSettings((prev) => ({ ...prev, open: false }));
        setSmtpAccountId(accountId);
      }}
    />
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
          },
    // currentViewKey stands for view, which is a new object each render.
    [status, unified, account, folders, scoped, currentViewKey, outboxInScope],
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
        openSettings("addresses");
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
      onSearch={(query) => void runSearch(query, searchAccount)}
      syncing={syncing}
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
      onThreadsAction={(ids, action, destination) => void threadsAction(ids, action, destination)}
      actionPending={actionPending}
      onToggleThreadFlag={(threadId) => void toggleThreadFlag(threadId)}
      onToggleMessageFlag={(message) => void toggleMessageFlag(message)}
      details={details}
      onOpenDetails={(message) => void openDetails(message)}
      onCloseDetails={closeDetails}
      onCopy={copy}
      onDownloadEml={(message) => void download(message, null)}
      onDownloadAttachment={(message, attachment) => void download(message, attachment)}
      onShowImages={showImages}
      onAlwaysShowImages={(message) => void alwaysShowImages(message)}
      onStopImages={(message) => void stopImages(message)}
      accountForm={accountForm}
      onOpenAccountForm={setAccountForm}
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
    />
    <TranslationSettings
      open={translateSettingsOpen}
      onOpenChange={translateSettingsChanged}
      load={loadTranslateSettings}
      save={saveTranslateSettings}
      clear={clearTranslations}
      onSaved={translateSettingsSaved}
    />
    {settingsDialog}
    </>
  );
}

/** The nav entry's unread count, kept current by the same realtime signal. */
function useUnreadBadge(): ExperimentalBadge | null {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    rpc.call("status_get", null).then(
      (status) => setCount(status.unreadCount),
      () => setCount(0),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, refresh);
  return count > 0 ? { count, label: "Unread mail" } : null;
}

/**
 * BB's sidebar while the Mail page is open: the mail rail in place of the
 * thread list. It draws what the page publishes and hands picks back to it.
 */
function MailFolderSidebar(_props: PluginNavPanelProps) {
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
        if (!mailPageLink.send({ kind: "settings" })) navigate.toPluginPanel("mail");
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

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar, routed at
// /plugins/makosh-mail/mail; while it is open, BB's sidebar shows the mail
// rail instead of the thread list.
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: "Mail",
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
});
