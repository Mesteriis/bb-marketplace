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
  Folder,
  MAIL_CHANGED_CHANNEL as MailChangedChannel,
  MessageAction,
  MessageHeader,
  NewAccountInput,
  StatusView,
} from "./src/core/index.ts";
import { DEFAULT_FOLDER_PATH, inboxPath } from "./src/ui/folder-list.tsx";
import {
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

function MailPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();

  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [chosenAccountId, setChosenAccountId] = useState<string | null>(null);
  /** Folders and the chosen folder, each tagged with the account they belong to. */
  const [folderState, setFolderState] = useState<{
    accountId: string;
    folders: Folder[];
    error: string | null;
  } | null>(null);
  const [chosenFolder, setChosenFolder] = useState<{ accountId: string; path: string } | null>(
    null,
  );
  const [actionPending, setActionPending] = useState(false);
  const [list, setList] = useState<ThreadListState>(EMPTY_LIST);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [reading, setReading] = useState<ReadingState>(NO_READING);
  const [syncing, setSyncing] = useState(false);
  const [accountForm, setAccountForm] = useState<AccountFormRequest>(null);

  const accounts = status?.accounts ?? [];
  const account = accounts.find((a) => a.id === chosenAccountId) ?? accounts[0] ?? null;
  const accountId = status?.vaultReady ? (account?.id ?? null) : null;
  const folders =
    folderState !== null && folderState.accountId === accountId ? folderState.folders : null;
  const foldersError =
    folderState !== null && folderState.accountId === accountId ? folderState.error : null;
  const chosenPath =
    chosenFolder !== null && chosenFolder.accountId === accountId ? chosenFolder.path : null;
  // The chosen folder while it still exists, else the account's inbox.
  const folderPath =
    (chosenPath !== null && folders?.some((f) => f.path === chosenPath && f.selectable)
      ? chosenPath
      : null) ??
    inboxPath(folders) ??
    DEFAULT_FOLDER_PATH;

  // Latest values for callbacks that outlive a render (realtime, async results).
  const latest = useRef({ accountId, folderPath, folderState, list, search, reading });
  latest.current = { accountId, folderPath, folderState, list, search, reading };
  /** Messages this page already marked opened, so message_open runs once each. */
  const opened = useRef(new Set<string>());
  const requests = useRef({ list: 0, search: 0, thread: 0, folders: 0 });
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
    async (forAccount: string, folder: string, mode: "reset" | "refresh" | "more") => {
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
          const page = await rpc.call("threads_list", {
            scope: { kind: "account", accountId: forAccount, folder },
            cursor,
            limit,
          });
          if (token !== requests.current.list) return;
          threads.push(...page.threads);
          cursor = page.nextCursor;
        } while (cursor !== null && threads.length < wanted);
        setList((prev) => ({
          threads: mode === "more" ? [...prev.threads, ...threads] : threads,
          nextCursor: cursor,
          loading: false,
          loadingMore: false,
          error: null,
        }));
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
    async (forAccount: string) => {
      const token = ++requests.current.folders;
      try {
        const { folders: next } = await rpc.call("folders_list", { accountId: forAccount });
        if (token !== requests.current.folders) return;
        setFolderState({ accountId: forAccount, folders: next, error: null });
      } catch (error) {
        if (token !== requests.current.folders) return;
        const text = messageOf(error);
        const prev = latest.current.folderState;
        const same = prev !== null && prev.accountId === forAccount;
        if (!same || prev.error === null) toast.error(`Could not load folders: ${text}`);
        setFolderState({ accountId: forAccount, folders: same ? prev.folders : [], error: text });
      }
    },
    [rpc],
  );

  const runSearch = useCallback(
    async (query: string, forAccount: string | null) => {
      const token = ++requests.current.search;
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
        const detail = await rpc.call("thread_get", {
          threadId,
          folder: latest.current.folderPath,
        });
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

  // A new active account loads its folders and re-runs the search for it.
  useEffect(() => {
    if (accountId === null) return;
    void loadFolders(accountId);
    const query = latest.current.search.query;
    if (query !== "") void runSearch(query, accountId);
  }, [accountId, loadFolders, runSearch]);

  // A new account or folder starts from its first page with nothing open.
  useEffect(() => {
    requests.current.thread++;
    setReading(NO_READING);
    if (accountId === null) {
      setList(EMPTY_LIST);
      return;
    }
    void loadList(accountId, folderPath, "reset");
  }, [accountId, folderPath, loadList]);

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

  useDebouncedRealtime(MAIL_CHANGED_CHANNEL, (payloads) => {
    void loadStatus();
    const {
      accountId: active,
      folderPath: folder,
      search: currentSearch,
      reading: currentReading,
    } = latest.current;
    if (active === null) return;
    const touched = payloads.some((payload) => {
      const changed = changedAccount(payload);
      return changed === null || changed === active;
    });
    if (!touched) return;
    stopSyncing();
    void loadList(active, folder, "refresh");
    void loadFolders(active);
    if (currentSearch.query !== "") void runSearch(currentSearch.query, active);
    // A thread still opening loads fresh data anyway; refreshing it now would
    // supersede the open and drop which message to expand.
    if (currentReading.threadId !== null && !currentReading.loading) {
      void loadThread(currentReading.threadId, null);
    }
  });

  const selectThread = useCallback(
    (threadId: string, messageId: string | null) => {
      setReading({ ...NO_READING, threadId, loading: true });
      void loadThread(threadId, { focusId: messageId });
    },
    [loadThread],
  );

  const closeThread = useCallback(() => {
    requests.current.thread++;
    setReading(NO_READING);
  }, []);

  /** A folder change resets the list (the effect above) and ends any search. */
  const selectFolder = useCallback(
    (path: string) => {
      if (accountId === null) return;
      setChosenFolder({ accountId, path });
      if (latest.current.search.query !== "") void runSearch("", accountId);
    },
    [accountId, runSearch],
  );

  /**
   * Moves the open conversation's messages in the folder being viewed (copies
   * in other folders stay). On success the conversation leaves the list at once.
   */
  const runAction = useCallback(
    async (action: MessageAction) => {
      const { accountId: active, folderPath: folder, reading: current } = latest.current;
      const threadId = current.threadId;
      const messageIds = (current.detail?.messages ?? [])
        .filter((m) => m.folder === folder)
        .map((m) => m.id);
      if (active === null || threadId === null || messageIds.length === 0) return;
      setActionPending(true);
      try {
        // One account and one source folder: the result has one group.
        const { groups } = await rpc.call("message_action", { messageIds, folder, action });
        const group = groups[0];
        if (group === undefined || group.error !== null) {
          throw new Error(group?.error ?? "Nothing was moved");
        }
        toast.success(`Moved to ${group.destination}`);
        if (latest.current.reading.threadId === threadId) {
          requests.current.thread++;
          setReading(NO_READING);
        }
        if (latest.current.accountId === active) {
          if (latest.current.folderPath === folder) {
            setList((prev) => ({ ...prev, threads: prev.threads.filter((t) => t.id !== threadId) }));
            void loadList(active, folder, "refresh");
          }
          void loadFolders(active);
          const query = latest.current.search.query;
          if (query !== "") void runSearch(query, active);
        }
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        setActionPending(false);
      }
    },
    [loadFolders, loadList, rpc, runSearch],
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
    if (accountId === null) return;
    setSyncing(true);
    if (syncTimer.current !== null) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(stopSyncing, SYNC_INDICATOR_MS);
    try {
      const { started } = await rpc.call("sync_now", { accountId });
      if (!started) stopSyncing();
    } catch (error) {
      stopSyncing();
      toast.error(`Sync failed: ${messageOf(error)}`);
    }
  }, [accountId, rpc, stopSyncing]);

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
      setChosenAccountId(saved.id);
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
      onSelectAccount={setChosenAccountId}
      list={list}
      folders={folders}
      foldersError={foldersError}
      folderPath={folderPath}
      onSelectFolder={selectFolder}
      onLoadMore={() => {
        if (accountId !== null) void loadList(accountId, folderPath, "more");
      }}
      search={search}
      onSearch={(query) => void runSearch(query, accountId)}
      syncing={syncing}
      onSync={() => void sync()}
      reading={reading}
      onSelectThread={selectThread}
      onCloseThread={closeThread}
      onToggleMessage={toggleMessage}
      onOpenLink={openLink}
      onHandToAgent={(message) => void handToAgent(message)}
      onAction={(action) => void runAction(action)}
      actionPending={actionPending}
      onShowImages={showImages}
      onAlwaysShowImages={(message) => void alwaysShowImages(message)}
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
