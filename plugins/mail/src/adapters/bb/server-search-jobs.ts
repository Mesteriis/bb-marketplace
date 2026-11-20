// Server search, older mail and whole conversations (slice 3h, #35 and #34):
// polled jobs that read the owner's own mail servers and store what they
// find with `kept` (spec "Server search", "Older mail", resolutions 6, 7).
//
// - Read-only: every session is opened with `readOnly: true` (EXAMINE) and
//   only SEARCH, STATUS and BODY.PEEK fetches run on it. The jobs never
//   write to a server, so they do not wait for the account's write queue;
//   store writes are synchronous transactions like sync's.
// - New mail is never hidden (spec resolution 6): before every insert a
//   folder's sync_state is read; a folder with none, or whose UIDVALIDITY
//   differs, is skipped, and uids above last_uid are never inserted (they
//   belong to the next incremental round). Job rows never enter a sync
//   outcome, so new-mail hooks, rules and reminders never see them.
// - One task per account in a job; at most one task runs per account and
//   three in all. Each task has a time budget; Cancel and the budget stop
//   it between folders and between fetch batches, and what was fetched
//   stays. Threads are rebuilt once per stored batch.
// - Logs carry job ids, account ids, counts and reason codes only: never a
//   query, folder name, label or message text.
import {
  CONVERSATION_MAX,
  HISTORY_STEP_MAX,
  SERVER_SEARCH_CAPS,
  buildThreads,
  conversationSearches,
  dedupKeyOf,
  emptyStepsNote,
  historyRange,
  jobInsertable,
  nextHistorySince,
  planServerSearch,
  postFilter,
  prepareMessage,
  ImapAuthError,
  type ChangeNotifier,
  type Clock,
  type FetchedMessage,
  type FolderSession,
  type ImapConfig,
  type ImapGateway,
  type MailStore,
  type ParsedQuery,
  type PrepareContext,
  type SecretVault,
  type SearchField,
  type ServerCriteria,
} from "../../core/index.ts";

export type JobKind = "search" | "history" | "conversation";
export type JobState = "running" | "done" | "failed" | "cancelled";
export type JobReason =
  | "not_synced"
  | "changed"
  | "search_failed"
  | "time_budget"
  | "cancelled"
  | "connection_failed"
  | "password_needed"
  | "nothing_to_search";

/** One account's part of a job, as server_job_poll reports it. */
export type JobAccountView = {
  accountId: string;
  /** Folders searched so far. */
  searched: number;
  /** Folders planned (those over the cap included). */
  total: number;
  /** Messages stored (or matched to a stored copy) by this job. */
  fetched: number;
  /** Uids the server matched that the job may insert. */
  found: number;
  /** Uids left out: above last_uid, or in a folder skipped as not synced or changed. */
  skipped: number;
  partial: boolean;
  reason: JobReason | null;
};

export type JobView = {
  state: JobState;
  accounts: JobAccountView[];
  messageIds: string[];
  moreAvailable: boolean;
  historySince?: string | null;
  emptySteps?: number;
};

export type ServerJobLimits = {
  /** Tasks running at once over all accounts. */
  total: number;
  /** Time budget of one account's task. */
  accountMs: number;
  /** Messages fetched per batch (and per "More from the server"). */
  batch: number;
  /** Finished jobs kept for polling. */
  keepJobs: number;
};

export const SERVER_JOB_LIMITS: ServerJobLimits = {
  total: 3,
  accountMs: SERVER_SEARCH_CAPS.accountMs,
  batch: SERVER_SEARCH_CAPS.batch,
  keepJobs: 50,
};

export type ServerJobSettings = {
  historyStepDays: number;
  /** As sync's classify / devHosts, so job rows are judged like synced rows. */
  classify?: boolean;
  devHosts?: readonly string[];
};

export interface ServerJobsDeps {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  clock: Clock;
  notifier?: ChangeNotifier;
  settings: () => ServerJobSettings;
  limits?: Partial<ServerJobLimits>;
  /** Monotonic milliseconds for budgets; defaults to Date.now. */
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

export type StartRefusal = "not_found" | "not_synced";

export interface ServerJobs {
  /** Searches the accounts' servers; `localOnly` lists operators the server does not use. */
  startSearch(parsed: ParsedQuery, accountIds: readonly string[]): { jobId: string; localOnly: SearchField[] };
  /** Fetches the next batch of a finished search's remaining hits. */
  more(jobId: string): "started" | "not_found" | "busy" | "none";
  startHistory(accountId: string, folder: string): { jobId: string } | { refused: StartRefusal };
  startConversation(threadId: string): { jobId: string } | { refused: StartRefusal };
  poll(jobId: string): JobView | null;
  cancel(jobId: string): boolean;
  /** Cancels every job (the plugin stops). */
  cancelAll(): void;
  /** Resolves when the job has no task left running or queued (tests and shutdown). */
  settled(jobId: string): Promise<void>;
}

const EPOCH = new Date(0).toISOString();
const DAY_MS = 86_400_000;

/** A folder's hits not fetched yet: the cursor of "More from the server". */
type Pending = { path: string; uids: number[] };

type AccountRun = JobAccountView & { pending: Pending[] };

type Job = {
  id: string;
  kind: JobKind;
  parsed: ParsedQuery | null;
  accounts: Map<string, AccountRun>;
  messageIds: string[];
  cancelled: boolean;
  /** Tasks queued or running. */
  open: number;
  waiters: (() => void)[];
  history?: { accountId: string; folder: string; since: string | null; emptySteps: number };
  finishedAt: number | null;
};

type Task = { job: Job; accountId: string; run: (signal: TaskSignal) => Promise<void> };

/** Checked between folders and between fetch batches. */
type TaskSignal = { stop: () => JobReason | null };

/** Thrown inside a task to end it with a reason. */
class TaskEnd extends Error {
  constructor(readonly reason: JobReason) {
    super(reason);
    this.name = "TaskEnd";
  }
}

function reasonOf(error: unknown): JobReason {
  if (error instanceof TaskEnd) return error.reason;
  if (error instanceof ImapAuthError) return "password_needed";
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SearchFailed" ? "search_failed" : "connection_failed";
}

function dayOf(iso: string, shiftDays = 0): string {
  return new Date(Date.parse(iso) + shiftDays * DAY_MS).toISOString().slice(0, 10);
}

async function closeQuietly(session: FolderSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // Read-only session: nothing to lose.
  }
}

export function createServerJobs(deps: ServerJobsDeps): ServerJobs {
  const { store, gateway } = deps;
  const limits: ServerJobLimits = { ...SERVER_JOB_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  let counter = 0;
  const newId = deps.newId ?? (() => `job_${Date.now().toString(36)}_${(++counter).toString(36)}`);
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop a job.
    }
  };

  const jobs = new Map<string, Job>();
  const queue: Task[] = [];
  const runningAccounts = new Set<string>();
  /** X-GM-EXT-1 per account, learned from a session. */
  const gmailKnown = new Map<string, boolean>();
  /** Empty history steps in a row per account and folder (the list speaks at three). */
  const emptySteps = new Map<string, number>();

  function newJob(kind: JobKind, parsed: ParsedQuery | null): Job {
    const job: Job = {
      id: newId(),
      kind,
      parsed,
      accounts: new Map(),
      messageIds: [],
      cancelled: false,
      open: 0,
      waiters: [],
      finishedAt: null,
    };
    jobs.set(job.id, job);
    prune();
    return job;
  }

  function prune(): void {
    const finished = [...jobs.values()].filter((j) => j.open === 0 && j.finishedAt !== null);
    if (finished.length <= limits.keepJobs) return;
    finished.sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const job of finished.slice(0, finished.length - limits.keepJobs)) jobs.delete(job.id);
  }

  function accountRun(job: Job, accountId: string): AccountRun {
    let run = job.accounts.get(accountId);
    if (run === undefined) {
      run = { accountId, searched: 0, total: 0, fetched: 0, found: 0, skipped: 0, partial: false, reason: null, pending: [] };
      job.accounts.set(accountId, run);
    }
    return run;
  }

  function enqueue(job: Job, accountId: string, run: Task["run"]): void {
    accountRun(job, accountId);
    job.open++;
    job.finishedAt = null;
    queue.push({ job, accountId, run });
    pump();
  }

  function pump(): void {
    while (runningAccounts.size < limits.total) {
      const index = queue.findIndex((task) => !runningAccounts.has(task.accountId));
      if (index < 0) return;
      const [task] = queue.splice(index, 1);
      void execute(task!);
    }
  }

  async function execute(task: Task): Promise<void> {
    const { job, accountId } = task;
    const run = accountRun(job, accountId);
    runningAccounts.add(accountId);
    const deadline = now() + limits.accountMs;
    const signal: TaskSignal = {
      stop: () => (job.cancelled ? "cancelled" : now() > deadline ? "time_budget" : null),
    };
    try {
      if (job.cancelled) throw new TaskEnd("cancelled");
      await task.run(signal);
    } catch (error) {
      const reason = reasonOf(error);
      run.reason = reason;
      if (reason === "cancelled" || reason === "time_budget") run.partial = true;
      if (!(error instanceof TaskEnd)) log(`server job ${job.id}: account ${accountId} ended (${reason})`);
    } finally {
      runningAccounts.delete(accountId);
      job.open--;
      if (job.open === 0) {
        job.finishedAt = now();
        log(
          `server job ${job.id} ${job.kind}: ${stateOf(job)}, fetched ${[...job.accounts.values()].reduce((n, a) => n + a.fetched, 0)}, skipped ${[...job.accounts.values()].reduce((n, a) => n + a.skipped, 0)}`,
        );
        for (const resolve of job.waiters.splice(0)) resolve();
      }
      pump();
    }
  }

  function stateOf(job: Job): JobState {
    if (job.open > 0) return "running";
    if (job.cancelled) return "cancelled";
    const runs = [...job.accounts.values()];
    const failing = new Set<JobReason>(["search_failed", "connection_failed", "password_needed"]);
    if (runs.length > 0 && runs.every((r) => r.reason !== null && failing.has(r.reason) && r.fetched === 0)) return "failed";
    return "done";
  }

  /** What judging a fetched message needs from the account; the folder's role is added per folder. */
  type AccountContext = Omit<PrepareContext, "folderRole">;

  function configOf(accountId: string): { config: ImapConfig; context: AccountContext } {
    const account = store.getAccount(accountId);
    if (account === null) throw new TaskEnd("connection_failed");
    if (account.authFailed) throw new TaskEnd("password_needed");
    let password: string;
    try {
      password = deps.vault.open(account.passwordSealed);
    } catch {
      throw new TaskEnd("password_needed");
    }
    const settings = deps.settings();
    return {
      config: { host: account.host, port: account.port, user: account.username, password, authKind: account.authKind },
      context: {
        preset: account.preset,
        classifyDev: settings.classify === true,
        devHosts: new Set((settings.devHosts ?? []).map((host) => host.toLowerCase())),
      },
    };
  }

  /** Opens a folder read-only (EXAMINE), always closed after `use`. */
  async function withSession<T>(config: ImapConfig, accountId: string, path: string, use: (session: FolderSession) => Promise<T>): Promise<T> {
    const session = await gateway.openFolder(config, path, { readOnly: true });
    try {
      gmailKnown.set(accountId, session.capabilities().gmail);
      return await use(session);
    } finally {
      await closeQuietly(session);
    }
  }

  /** Whether the account is Gmail: from a session, probed on the Inbox the first time. */
  async function gmailOf(accountId: string, config: ImapConfig): Promise<boolean> {
    const known = gmailKnown.get(accountId);
    if (known !== undefined) return known;
    const inbox = store.listFolders(accountId).find((f) => f.specialUse === "inbox" && f.selectable)?.path ?? "INBOX";
    return withSession(config, accountId, inbox, async (session) => session.capabilities().gmail);
  }

  function rebuildThreads(accountId: string): void {
    store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)));
    try {
      deps.notifier?.mailChanged(accountId);
    } catch {
      // A broken notifier must not stop a job.
    }
  }

  function addIds(job: Job, ids: readonly string[]): void {
    for (const id of ids) if (!job.messageIds.includes(id)) job.messageIds.push(id);
  }

  /**
   * Fetches `uids` (newest first) of one folder on an open read-only session
   * and stores them with `kept`, in batches, after jobInsertable against the
   * folder's sync_state (spec resolution 6). Server-search hits pass
   * postFilter and are matched to a stored copy by dedup key. `left`: the
   * insertable uids not reached (past `max`; on a stop the TaskEnd carries
   * them); `processed`: the uids tried; `insertable`: how many the folder
   * allowed (none when it was skipped).
   */
  async function fetchInto(
    job: Job,
    run: AccountRun,
    session: FolderSession,
    path: string,
    uids: readonly number[],
    kept: "history" | "search",
    accountContext: AccountContext,
    signal: TaskSignal,
    max: number,
  ): Promise<{ left: number[]; stored: number; processed: number; insertable: number }> {
    const accountId = run.accountId;
    // Slice 3i (resolution 3): rows are judged with the role of the folder they land in.
    const folderRole = store.listFolders(accountId).find((folder) => folder.path === path)?.specialUse ?? null;
    const context: PrepareContext = { ...accountContext, folderRole };
    const status = await session.status();
    const insertable = jobInsertable(uids, store.getSyncState(accountId, path), status.uidValidity);
    run.skipped += insertable.skipped;
    if (insertable.reason !== undefined) {
      run.reason ??= insertable.reason;
      return { left: [], stored: 0, processed: 0, insertable: 0 };
    }
    const todo = insertable.uids.slice(0, max);
    let left = insertable.uids.slice(max);
    let stored = 0;
    for (let i = 0; i < todo.length; i += limits.batch) {
      const stop = signal.stop();
      if (stop !== null) {
        left = [...todo.slice(i), ...left];
        throw Object.assign(new TaskEnd(stop), { left });
      }
      const batch = todo.slice(i, i + limits.batch);
      let messages: FetchedMessage[] = await session.fetchMessages(batch);
      if (kept === "search" && job.parsed !== null) {
        const parsed = job.parsed;
        messages = messages.filter((m) =>
          postFilter(
            {
              hasAttachments: m.attachments.some((a) => !a.isInline),
              filenames: m.attachments.map((a) => a.filename ?? ""),
              date: m.date,
            },
            parsed,
          ),
        );
      }
      let matched: string[] = [];
      if (kept === "search") {
        const keys = messages.map((m) => dedupKeyOf(m.gmMsgId, m.messageId, m.size, "")).filter((k) => !k.startsWith("id:"));
        const existing = store.idsByDedupKey(accountId, keys);
        matched = [...existing.values()];
        messages = messages.filter((m) => !existing.has(dedupKeyOf(m.gmMsgId, m.messageId, m.size, "")));
      }
      const prepared = messages.map((m) => prepareMessage(m, context));
      if (prepared.length > 0) {
        store.transaction(() => {
          store.upsertMessages(accountId, path, prepared, { kept });
          const labels = prepared.flatMap((m) => (m.gmLabels === undefined ? [] : [{ uid: m.uid, labels: m.gmLabels }]));
          if (labels.length > 0) store.setGmLabels(accountId, path, labels);
        });
      }
      const index = new Map(store.localFolderIndex(accountId, path, EPOCH).map((e) => [e.uid, e.id] as const));
      const ids = prepared.flatMap((m) => {
        const id = index.get(m.uid);
        return id === undefined ? [] : [id];
      });
      addIds(job, [...ids, ...matched]);
      run.fetched += ids.length + matched.length;
      stored += prepared.length;
      if (prepared.length > 0) rebuildThreads(accountId);
    }
    return { left, stored, processed: todo.length, insertable: insertable.uids.length };
  }

  /** Uids of the folder already stored here: they are not fetched again. */
  function storedUids(accountId: string, path: string): Set<number> {
    return new Set(store.localFolderIndex(accountId, path, EPOCH).map((e) => e.uid));
  }

  // ---- Server search ------------------------------------------------------

  async function searchAccount(job: Job, accountId: string, signal: TaskSignal): Promise<void> {
    const run = accountRun(job, accountId);
    const { config, context } = configOf(accountId);
    const gmail = await gmailOf(accountId, config);
    const plan = planServerSearch(job.parsed!, { gmail }, store.listFolders(accountId));
    if (plan.kind === "refused") throw new TaskEnd("nothing_to_search");
    const runs: { path: string; criteria: ServerCriteria }[] =
      plan.kind === "gmail"
        ? plan.runs.map((r) => ({ path: r.folder, criteria: { gmailRaw: r.raw } }))
        : plan.runs.map((r) => ({ path: r.path, criteria: r.criteria }));
    run.total = runs.length + (plan.kind === "folders" ? plan.skipped : 0);
    let budget = limits.batch;
    for (const { path, criteria } of runs) {
      const stop = signal.stop();
      if (stop !== null) throw new TaskEnd(stop);
      try {
        await withSession(config, accountId, path, async (session) => {
          const uids = await session.searchServer(criteria);
          run.searched++;
          run.found += uids.length;
          const known = storedUids(accountId, path);
          const fresh = uids.filter((uid) => !known.has(uid));
          // Checked here too, so a skipped folder reports its reason even when no batch reaches it.
          const status = await session.status();
          const insertable = jobInsertable(fresh, store.getSyncState(accountId, path), status.uidValidity);
          run.skipped += insertable.skipped;
          if (insertable.reason !== undefined) {
            run.reason ??= insertable.reason;
            return;
          }
          if (budget <= 0) {
            if (insertable.uids.length > 0) run.pending.push({ path, uids: insertable.uids });
            return;
          }
          try {
            const done = await fetchInto(job, run, session, path, insertable.uids, "search", context, signal, budget);
            budget -= done.processed;
            if (done.left.length > 0) run.pending.push({ path, uids: done.left });
          } catch (error) {
            const left = (error as { left?: number[] }).left;
            if (left !== undefined && left.length > 0) run.pending.push({ path, uids: left });
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof TaskEnd || error instanceof ImapAuthError) throw error;
        const reason = reasonOf(error);
        run.reason = reason;
        // A refused SEARCH in one folder: the others are still searched.
        if (reason !== "search_failed") throw new TaskEnd(reason);
      }
    }
  }

  async function moreAccount(job: Job, accountId: string, signal: TaskSignal): Promise<void> {
    const run = accountRun(job, accountId);
    const { config, context } = configOf(accountId);
    let budget = limits.batch;
    while (budget > 0 && run.pending.length > 0) {
      const stop = signal.stop();
      if (stop !== null) throw new TaskEnd(stop);
      const next = run.pending.shift()!;
      const known = storedUids(accountId, next.path);
      const fresh = next.uids.filter((uid) => !known.has(uid));
      if (fresh.length === 0) continue;
      try {
        await withSession(config, accountId, next.path, async (session) => {
          const done = await fetchInto(job, run, session, next.path, fresh, "search", context, signal, budget);
          budget -= done.processed;
          if (done.left.length > 0) run.pending.unshift({ path: next.path, uids: done.left });
        });
      } catch (error) {
        const left = (error as { left?: number[] }).left;
        if (left !== undefined && left.length > 0) run.pending.unshift({ path: next.path, uids: left });
        throw error;
      }
    }
  }

  // ---- Older mail ---------------------------------------------------------

  async function historyAccount(job: Job, accountId: string, folder: string, signal: TaskSignal): Promise<void> {
    const run = accountRun(job, accountId);
    run.total = 1;
    const state = store.getSyncState(accountId, folder);
    if (state === null) throw new TaskEnd("not_synced");
    const { config, context } = configOf(accountId);
    const key = `${accountId}\u0000${folder}`;
    const historySince = store.historyState(accountId, folder)?.historySince ?? null;
    const range = historyRange({ historySince, syncedSince: state.syncedSince }, deps.settings().historyStepDays);
    let newCount = 0;
    let completed = false;
    try {
      await withSession(config, accountId, folder, async (session) => {
        // SINCE / BEFORE match whole days of INTERNALDATE: a day of slack at the window side; stored uids are skipped.
        const uids = await session.searchServer({ since: dayOf(range.from), before: dayOf(range.before, 1) });
        run.searched = 1;
        run.found += uids.length;
        const known = storedUids(accountId, folder);
        const fresh = uids.filter((uid) => !known.has(uid));
        const done = await fetchInto(job, run, session, folder, fresh, "history", context, signal, HISTORY_STEP_MAX);
        if (run.reason === "changed") return;
        newCount = done.insertable;
        completed = true;
        // Server hits this step covers become history (spec resolution 7): fetched again, they keep their ids.
        const matched = new Set(uids);
        const searchRows = new Set(store.keptIds(accountId, folder, "search"));
        const covered = store
          .localFolderIndex(accountId, folder, EPOCH)
          .filter((e) => searchRows.has(e.id) && matched.has(e.uid))
          .map((e) => e.uid);
        if (covered.length > 0) await fetchInto(job, run, session, folder, covered, "history", context, signal, covered.length);
      });
    } catch (error) {
      // Stopped midway: history_since stays and the step is not an empty one;
      // the next step runs the same range, skipping what was stored.
      if (error instanceof TaskEnd) job.history = { accountId, folder, since: historySince, emptySteps: emptySteps.get(key) ?? 0 };
      throw error;
    }
    const since = completed ? nextHistorySince(range, { newCount, stopped: false }) : null;
    if (since === null) {
      // Not run (the folder changed), or more than HISTORY_STEP_MAX new: the same range runs again.
      if (completed) emptySteps.set(key, 0);
      job.history = { accountId, folder, since: historySince, emptySteps: emptySteps.get(key) ?? 0 };
      return;
    }
    store.setHistorySince(accountId, folder, since);
    const empty = newCount === 0 ? (emptySteps.get(key) ?? 0) + 1 : 0;
    emptySteps.set(key, empty);
    job.history = { accountId, folder, since, emptySteps: empty };
    if (emptyStepsNote(empty) !== null) log(`server job ${job.id}: account ${accountId} history has no older mail`);
  }

  // ---- Whole conversations ------------------------------------------------

  async function conversationAccount(job: Job, accountId: string, threadId: string, signal: TaskSignal): Promise<void> {
    const run = accountRun(job, accountId);
    const { config, context } = configOf(accountId);
    const detail = store.getThread(threadId, "");
    if (detail === null) return;
    const memberIds = new Set(detail.messages.map((m) => m.id));
    const inputs = store.threadingInputs(accountId).filter((input) => memberIds.has(input.id));
    const search = conversationSearches({
      messageIds: inputs.flatMap((i) => (i.messageId === null ? [] : [i.messageId])),
      refs: inputs.flatMap((i) => [...i.references, ...(i.inReplyTo === null ? [] : [i.inReplyTo])]),
      gmThrid: inputs.find((i) => i.gmThreadId !== null)?.gmThreadId ?? null,
    });
    const folders = store.listFolders(accountId).filter((f) => f.selectable);
    let targets: { path: string; criteria: ServerCriteria }[];
    if (search.kind === "gmail" && folders.some((f) => f.specialUse === "all")) {
      targets = [{ path: folders.find((f) => f.specialUse === "all")!.path, criteria: { threadId: search.threadId } }];
    } else {
      const headers =
        search.kind === "headers"
          ? search.searches.map((s) => ({ name: s.header, value: s.value }))
          : inputs.flatMap((i) => (i.messageId === null ? [] : [{ name: "Message-ID", value: i.messageId }]));
      if (headers.length === 0) return;
      const paths: string[] = [];
      for (const m of detail.messages) if (!paths.includes(m.folder)) paths.push(m.folder);
      for (const f of folders) if ((f.specialUse === "sent" || f.specialUse === "archive") && !paths.includes(f.path)) paths.push(f.path);
      targets = paths.filter((p) => folders.some((f) => f.path === p)).map((path) => ({ path, criteria: { headers } }));
    }
    run.total = targets.length;
    let budget = CONVERSATION_MAX;
    for (const { path, criteria } of targets) {
      const stop = signal.stop();
      if (stop !== null) throw new TaskEnd(stop);
      if (budget <= 0) break;
      try {
        await withSession(config, accountId, path, async (session) => {
          const uids = await session.searchServer(criteria);
          run.searched++;
          const known = storedUids(accountId, path);
          const fresh = uids.filter((uid) => !known.has(uid));
          run.found += uids.length;
          // Kept as server hits: these rows lie outside [history_since, window)
          // and expire like them unless opened (or a history step covers them).
          const done = await fetchInto(job, run, session, path, fresh, "search", context, signal, budget);
          budget -= done.processed;
        });
      } catch (error) {
        if (error instanceof TaskEnd || error instanceof ImapAuthError) throw error;
        const reason = reasonOf(error);
        run.reason = reason;
        if (reason !== "search_failed") throw new TaskEnd(reason);
      }
    }
  }

  // ---- The port -----------------------------------------------------------

  function localOnlyOf(parsed: ParsedQuery, accountIds: readonly string[]): SearchField[] {
    const fields: SearchField[] = [];
    for (const accountId of accountIds) {
      const gmail = gmailKnown.get(accountId) ?? store.getAccount(accountId)?.preset === "gmail";
      for (const field of planServerSearch(parsed, { gmail }, store.listFolders(accountId)).localOnly) {
        if (!fields.includes(field)) fields.push(field);
      }
    }
    return fields;
  }

  const api: ServerJobs = {
    startSearch(parsed, accountIds) {
      const job = newJob("search", parsed);
      for (const accountId of accountIds) enqueue(job, accountId, (signal) => searchAccount(job, accountId, signal));
      return { jobId: job.id, localOnly: localOnlyOf(parsed, accountIds) };
    },

    more(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined || job.kind !== "search") return "not_found";
      if (job.open > 0) return "busy";
      const waiting = [...job.accounts.values()].filter((r) => r.pending.length > 0);
      if (waiting.length === 0) return "none";
      job.cancelled = false;
      for (const run of waiting) {
        run.reason = null;
        run.partial = false;
        enqueue(job, run.accountId, (signal) => moreAccount(job, run.accountId, signal));
      }
      return "started";
    },

    startHistory(accountId, folder) {
      if (store.getAccount(accountId) === null || !store.listFolders(accountId).some((f) => f.path === folder)) {
        return { refused: "not_found" };
      }
      if (store.getSyncState(accountId, folder) === null) return { refused: "not_synced" };
      const job = newJob("history", null);
      enqueue(job, accountId, (signal) => historyAccount(job, accountId, folder, signal));
      return { jobId: job.id };
    },

    startConversation(threadId) {
      const detail = store.getThread(threadId, "");
      if (detail === null) return { refused: "not_found" };
      const accountId = detail.thread.accountId;
      const job = newJob("conversation", null);
      enqueue(job, accountId, (signal) => conversationAccount(job, accountId, threadId, signal));
      return { jobId: job.id };
    },

    poll(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) return null;
      const state = stateOf(job);
      const view: JobView = {
        state,
        accounts: [...job.accounts.values()].map(({ pending: _pending, ...account }) => ({ ...account })),
        messageIds: [...job.messageIds],
        moreAvailable: state !== "running" && [...job.accounts.values()].some((r) => r.pending.length > 0),
      };
      if (job.kind === "history") {
        view.historySince = job.history?.since ?? null;
        view.emptySteps = job.history?.emptySteps ?? 0;
      }
      return view;
    },

    cancel(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) return false;
      if (job.open === 0) return true;
      job.cancelled = true;
      // Queued tasks end at once; a running one stops at its next check.
      for (let i = queue.length - 1; i >= 0; i--) {
        const task = queue[i]!;
        if (task.job !== job) continue;
        queue.splice(i, 1);
        const run = accountRun(job, task.accountId);
        run.reason = "cancelled";
        run.partial = true;
        job.open--;
      }
      if (job.open === 0) {
        job.finishedAt = now();
        for (const resolve of job.waiters.splice(0)) resolve();
      }
      return true;
    },

    cancelAll() {
      for (const job of [...jobs.values()]) if (job.open > 0) api.cancel(job.id);
    },

    settled(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined || job.open === 0) return Promise.resolve();
      return new Promise((resolve) => job.waiters.push(resolve));
    },
  };
  return api;
}
