// Makosh Mail — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// This file is the BB adapter: it owns RPC, realtime refreshes, navigation and
// the composer, and hands plain data and callbacks to the host-agnostic page
// in src/ui.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_saveFile,
  UrlLink,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import type {
  AttachmentMeta,
  Folder,
  MAIL_CHANGED_CHANNEL as MailChangedChannel,
  MessageAction,
  MessageHeader,
  NewAccountInput,
  RoleCount,
  StatusView,
  ThreadDetail,
} from "./src/core/index.ts";
import { isRoleMoveAction, roleFolders } from "./src/core/actions.ts";
import type { DetailsState } from "./src/ui/details-panel.tsx";
import {
  DEFAULT_FOLDER_PATH,
  inboxPath,
  viewKey,
  viewPaths,
  type MailView,
  type RoleName,
} from "./src/ui/folder-list.tsx";
import {
  ALL_ACCOUNTS,
  MailPage,
  type AccountFormRequest,
  type ReadingState,
  type SearchState,
  type ThreadListState,
} from "./src/ui/mail-page.tsx";
import type { BodyState } from "./src/ui/reading-pane.tsx";
import { subjectOrPlaceholder } from "./src/ui/thread-list.tsx";

// The channel name is checked against the core constant without importing it
// at runtime: a value import of the core would bundle its zod schemas.
const MAIL_CHANGED_CHANNEL: typeof MailChangedChannel = "mail-changed";
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

type FolderState = { key: string; folders: Folder[]; roles: RoleCount[]; error: string | null };

function MailPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();

  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** An account id or ALL_ACCOUNTS; null until the owner chooses (All accounts when several). */
  const [chosen, setChosen] = useState<string | null>(null);
  /** Folders of the scope (an account, or ALL_ACCOUNTS), tagged with it. */
  const [folderState, setFolderState] = useState<FolderState | null>(null);
  const [chosenView, setChosenView] = useState<{ key: string; view: MailView } | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [list, setList] = useState<ThreadListState>(EMPTY_LIST);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [reading, setReading] = useState<ReadingState>(NO_READING);
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [details, setDetails] = useState<DetailsState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [accountForm, setAccountForm] = useState<AccountFormRequest>(null);

  const accounts = status?.accounts ?? [];
  const chosenAccount =
    chosen !== null && chosen !== ALL_ACCOUNTS ? (accounts.find((a) => a.id === chosen) ?? null) : null;
  const unified = accounts.length > 1 && chosenAccount === null;
  const account = unified ? null : (chosenAccount ?? accounts[0] ?? null);
  const scopeKey = status?.vaultReady ? (unified ? ALL_ACCOUNTS : (account?.id ?? null)) : null;
  const scoped = folderState !== null && folderState.key === scopeKey ? folderState : null;
  const folders = scoped?.folders ?? null;
  const picked = chosenView !== null && chosenView.key === scopeKey ? chosenView.view : null;
  // The chosen folder while it still exists, else the inbox (or the merged Inbox).
  const view: MailView = (() => {
    const exists = (v: MailView) =>
      v.kind === "role" ||
      (folders?.some((f) => f.accountId === v.accountId && f.path === v.path && f.selectable) ?? false);
    if (picked !== null && exists(picked)) return picked;
    if (unified || account === null) return { kind: "role", role: "inbox" };
    return { kind: "folder", accountId: account.id, path: inboxPath(folders) ?? DEFAULT_FOLDER_PATH };
  })();
  const currentViewKey = viewKey(view);
  const searchAccount = unified ? null : (account?.id ?? null);

  // Latest values for callbacks that outlive a render (realtime, async results).
  const latest = useRef({ scopeKey, searchAccount, unified, view, folders, list, search, reading, selection });
  latest.current = { scopeKey, searchAccount, unified, view, folders, list, search, reading, selection };
  /** Messages this page already marked opened, so message_open runs once each. */
  const opened = useRef(new Set<string>());
  /** The account of the conversation open in the reading pane. */
  const openAccount = useRef<string | null>(null);
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
          if ((error as { code?: unknown } | null)?.code === "not_found") setReading(NO_READING);
          return;
        }
        setReading((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
      }
    },
    [expandMessage, markOpened, rpc],
  );

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

  // A new view starts from its first page with nothing open or selected.
  useEffect(() => {
    requests.current.thread++;
    setReading(NO_READING);
    setSelection(NO_SELECTION);
    if (scopeKey === null) {
      setList(EMPTY_LIST);
      return;
    }
    void loadList(latest.current.view, "reset");
  }, [scopeKey, currentViewKey, loadList]);

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

  const selectThread = useCallback(
    (threadId: string, messageId: string | null, accountId: string) => {
      openAccount.current = accountId;
      setReading({ ...NO_READING, threadId, loading: true });
      void loadThread(threadId, { focusId: messageId });
    },
    [loadThread],
  );

  const closeThread = useCallback(() => {
    requests.current.thread++;
    setReading(NO_READING);
  }, []);

  /** A view change resets the list (the effect above) and ends any search. */
  const selectView = useCallback(
    (next: MailView) => {
      const { scopeKey: key, search: currentSearch, searchAccount: forAccount } = latest.current;
      if (key === null) return;
      setChosenView({ key, view: next });
      if (currentSearch.query !== "") void runSearch("", forAccount);
    },
    [runSearch],
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
      setChosen(saved.id);
      setAccountForm(null);
      await loadStatus();
    },
    [loadStatus, rpc],
  );

  return (
    <MailPage
      status={status}
      statusError={statusError}
      account={account}
      unified={unified}
      onSelectAccount={setChosen}
      folders={folders}
      roles={scoped?.roles ?? []}
      foldersError={scoped?.error ?? null}
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
      onSelectThread={selectThread}
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
    />
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

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar, routed at
// /plugins/makosh-mail/mail.
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: "Mail",
    icon: "Mail",
    path: "mail",
    component: MailPanel,
    experimental_useBadge: useUnreadBadge,
  });
});
