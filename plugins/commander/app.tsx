import type { SearchActions } from "./src/ui/search-panel.tsx";
import { definePluginApp, experimental_PluginRpcCallError, experimental_usePluginId, useBbNavigate, useRealtime, useRpc, useSdk, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { LIST_PAGE_MAX } from "./src/core/provider.ts";
import { parsePosix } from "./src/core/path.ts";
import { assembleImage, type ViewKind, type WireView } from "./src/core/preview.ts";
import { CommanderError } from "./src/core/errors.ts";
import { JobState, type ConflictAction, type Entry, type OperationJob, type OperationPlan, type ResourceRef } from "./src/core/model.ts";
import { rpcSchemas, type UiState } from "./src/core/wire/rpc.ts";
import { Workspace } from "./src/ui/index.ts";
import type { RetryNote } from "./src/ui/queue.tsx";
import { activeTab, currentRef, emptyState, nativePath, newTab, problemOf, unloaded,
  type Directory, type EndpointView, type JobView, type PlanRequest, type Problem, type Side } from "./src/ui/model.ts";
import { shortcuts, type KeyBindings, type Shortcut } from "./src/ui/keyboard.ts";
import type { ScanActions } from "./src/ui/compare-view.tsx";
import { ru } from "./src/ui/strings.ts";
import "./src/ui/workspace.css";

type Rpc = ReturnType<typeof useRpc<typeof rpcSchemas>>;
type Sdk = ReturnType<typeof useSdk>;
// S11: the pinned SDK cannot take a signal. Use HTTP cancellation when the
// transport is available; both paths also accept a request-id cancellation.
async function startSearch(rpc: Rpc, pluginId: string, input: Parameters<SearchActions["start"]>[0], signal: AbortSignal) {
  let response: Response | undefined;
  let envelope: { ok?: boolean; result?: unknown; error?: unknown } | null;
  try {
    response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/scan_start`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    signal.throwIfAborted();
    if (response.status === 401 || response.status === 404) return rpc.call("scan_start", input);
    envelope = await response.json();
  } catch (error) {
    signal.throwIfAborted();
    // A successful status can arrive before a truncated JSON body. Reuse the
    // same request id so the server can replay an already-created job.
    if (!(error instanceof TypeError) && !(error instanceof SyntaxError && response?.status === 200)) throw error;
    return rpc.call("scan_start", input);
  }
  signal.throwIfAborted();
  if (!response.ok || envelope?.ok !== true) throw experimental_PluginRpcCallError.from(envelope?.error);
  return rpcSchemas.scan_start.output.parse(envelope.result);
}

const delay = 250;
let pendingWrite = Promise.resolve();
const bindingsKey = "makosh-commander:key-bindings";

function loadBindings(): KeyBindings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(bindingsKey) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const keys = value as Record<string, unknown>;
    return Object.fromEntries((Object.keys(shortcuts) as Shortcut[])
      .filter((key) => typeof keys[key] === "string" && (keys[key] as string).length <= 64)
      .map((key) => [key, keys[key]]));
  } catch { return {}; }
}

async function initialState(rpc: Rpc, sdk: Sdk, environment: string | undefined,
  endpoints: EndpointView[], saved: UiState | null): Promise<UiState> {
  const state = saved ?? emptyState;
  const first = endpoints.find((endpoint) => endpoint.provider === "local") ?? endpoints[0];
  let preferred: EndpointView | undefined = first;
  let cwd: string | undefined;
  if (environment && !saved) {
    const env = await sdk.environments.get({ environmentId: environment });
    preferred = endpoints.find((endpoint) => endpoint.hostId === env.hostId);
    if (!preferred) throw new CommanderError("not_found", ru.noThreadEndpoint);
    cwd = env.path ?? undefined;
  }
  const second = endpoints.find((endpoint) => endpoint.id !== preferred?.id) ?? preferred;
  const initialize = async (pane: Side, source: EndpointView | undefined, threadPath?: string) => {
    const existing = activeTab(state, pane);
    if (existing && endpoints.some((item) => item.id === existing.endpoint)) return state[pane];
    if (!source) return emptyState[pane];
    let path;
    if (threadPath) path = parsePosix(threadPath);
    else try { path = (await rpc.call("endpoint_home", { endpoint: source.id })).path; }
    catch { path = { segments: [] }; }
    return { tabs: [newTab(source.id, path)], activeTab: 0 };
  };
  const [left, right] = await Promise.all([initialize("left", preferred, cwd), initialize("right", second)]);
  return { ...state, left, right };
}

function useWorkspaceState(rpc: Rpc, sdk: Sdk, threadId: string | undefined, environment: string | undefined) {
  const [state, setState] = useState<UiState>(emptyState);
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const current = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const mounted = useRef(false);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const snapshot = current.current;
    pendingWrite = pendingWrite.then(async () => {
      await rpc.call("ui_state_set", { state: snapshot, ...(threadId ? { threadId } : {}) });
    }).catch((error) => { if (mounted.current) setProblem(problemOf(error)); });
  }, [rpc, threadId]);

  useEffect(() => {
    mounted.current = true;
    const load = async () => {
      await pendingWrite;
      const [{ state: saved }, { endpoints: sources }] = await Promise.all([
        rpc.call("ui_state_get", threadId ? { threadId } : {}), rpc.call("endpoints_list", {}),
      ]);
      if (!active) return;
      setEndpoints(sources);
      const next = await initialState(rpc, sdk, environment, sources, saved);
      if (!active) return;
      current.current = next;
      setState(next);
      if (threadId && !saved && next.left.tabs.length > 0) {
        dirty.current = true;
        timer.current = setTimeout(flush, delay);
      }
    };
    let active = true;
    void load().catch((error) => { if (active) setProblem(problemOf(error)); });
    return () => { active = false; mounted.current = false; flush(); };
  }, [rpc, sdk, environment, threadId, flush]);

  const update = useCallback((change: (state: UiState) => UiState, saveNow = false) => {
    const next = change(current.current);
    if (next === current.current) return;
    current.current = next;
    setState(next);
    dirty.current = true;
    clearTimeout(timer.current);
    if (saveNow) flush();
    else timer.current = setTimeout(flush, delay);
  }, [flush]);

  const refreshEndpoints = useCallback(async () => {
    try { setEndpoints((await rpc.call("endpoints_list", {})).endpoints); }
    catch (error) { setProblem(problemOf(error)); }
  }, [rpc]);
  return { state, update, endpoints, problem, refreshEndpoints };
}

function useDirectory(rpc: Rpc, ref: ResourceRef | undefined, revision: number): Directory | undefined {
  const key = ref ? JSON.stringify(ref) : null;
  const [view, setView] = useState<{ key: string; directory: Directory } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    const snapshot = JSON.parse(key) as ResourceRef;
    const read = async () => {
      const entries: Entry[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { entries: Entry[]; cursor: string | null } = await rpc.call("dir_list", { ref: snapshot, cursor, limit: LIST_PAGE_MAX });
        if (!active) return;
        entries.push(...page.entries);
        cursor = page.cursor;
        if (cursor !== null) {
          if (cursors.has(cursor) || entries.length >= 100_000 || cursors.size >= 1_000) {
            throw new CommanderError("limit_exceeded", ru.unknownError);
          }
          cursors.add(cursor);
        }
      } while (cursor !== null);
      if (active) setView({ key, directory: { entries, loading: false, error: null } });
    };
    void read().catch((error) => {
      if (active) setView({ key, directory: { entries: [], loading: false, error: problemOf(error) } });
    });
    return () => { active = false; };
  }, [rpc, key, revision]);
  return key === null ? undefined : view?.key === key ? view.directory : unloaded;
}

async function readConflictJob(rpc: Rpc, jobId: string): Promise<OperationJob | null> {
  const job = await rpc.call("job_get", { jobId });
  return job && "plan" in job && job.state === "awaiting_decision" && job.pendingConflict ? job : null;
}

function useJobs(rpc: Rpc, revision: number) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Problem | null>(null);
  useEffect(() => {
    let live = true;
    const unknownJobs = async () => {
      const jobs: JobView[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page: { jobs: JobView[]; nextCursor?: string } = await rpc.call("job_list", { states: ["unknown"], limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        if (!live) return [];
        jobs.push(...page.jobs);
        cursor = page.nextCursor;
        if (cursor !== undefined && cursors.has(cursor)) break;
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined && jobs.length < 200);
      return jobs;
    };
    void Promise.all([rpc.call("job_list", { limit: 200 }), unknownJobs()])
      .then(([ordinary, uncertain]) => {
        if (!live) return;
        setJobs((previous) => {
          const next = new Map([...ordinary.jobs, ...uncertain].map((job) => [job.id, job]));
          const stable = previous.flatMap(({ id }) => {
            const updated = next.get(id);
            next.delete(id);
            return updated ? [updated] : [];
          });
          return [...stable, ...next.values()];
        });
        setError(null);
        setLoading(false);
      }, (failure) => {
        if (live) { setError(problemOf(failure)); setLoading(false); }
      });
    return () => { live = false; };
  }, [rpc, revision]);
  return { jobs, loading, error };
}

function CommanderPage({ compact = false, environment, threadId }: { compact?: boolean; environment?: string; threadId?: string }) {
  const rpc = useRpc<typeof rpcSchemas>();
  const pluginId = experimental_usePluginId();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { state, update, endpoints, problem, refreshEndpoints } = useWorkspaceState(rpc, sdk, threadId, environment);
  // A scan screen can close before scan_start returns. Keep one pending start
  // for each kind, matching the two slots in the persisted workspace state.
  const starting = useRef(new Set<"dirs" | "checksum">());
  const [startingScans, setStartingScans] = useState<ReadonlySet<"dirs" | "checksum">>(() => new Set());
  const scans = useMemo<ScanActions>(() => ({
    async start(input) {
      const { estimateOnly, estimateId: _estimateId, ...request } = input;
      if (estimateOnly) return rpc.call("scan_start", input);
      if (starting.current.has(request.kind)) throw new CommanderError("limit_exceeded", ru.busy);
      starting.current.add(request.kind);
      setStartingScans(new Set(starting.current));
      try {
        const reply = await rpc.call("scan_start", input);
        if ("id" in reply) {
          const scanId = reply.id;
          update((previous) => request.kind === "dirs"
            ? { ...previous, lastComparison: { scanId, request } }
            : { ...previous, lastChecksum: { scanId, request } }, true);
        }
        return reply;
      } finally {
        starting.current.delete(request.kind);
        setStartingScans(new Set(starting.current));
      }
    },
    get: (scanId) => rpc.call("scan_get", { scanId }),
    cancel: (scanId) => rpc.call("scan_cancel", { scanId }),
  }), [rpc, update]);
  // S11: polling and job cancellation use the shared scan transport.
  const search = useMemo<SearchActions>(() => ({
    start: (input, signal) => startSearch(rpc, pluginId, input, signal),
    get: scans.get,
    cancel: scans.cancel,
    cancelRequest: (clientRequestId) => rpc.call("scan_cancel", { clientRequestId }),
  }), [pluginId, rpc, scans]);
  const [bindings, setBindings] = useState(loadBindings);
  // S17: the last retry result by job id: nothing to retry, or files waiting for a directory check.
  const [retryNotes, setRetryNotes] = useState<Record<string, RetryNote>>({});
  const [revisions, setRevisions] = useState({ left: 0, right: 0, job: 0 });
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const changes = useRef(new Set<string>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const left = activeTab(state, "left"), right = activeTab(state, "right");
  const leftDir = useDirectory(rpc, left && currentRef(left), revisions.left);
  const rightDir = useDirectory(rpc, right && currentRef(right), revisions.right);
  const queue = useJobs(rpc, revisions.job);
  const refresh = (side: Side | "job") => setRevisions((previous) => ({ ...previous, [side]: previous[side] + 1 }));
  useRealtime("commander", (payload) => {
    if (typeof payload !== "object" || payload === null || !("kind" in payload)) return;
    if (payload.kind === "job") changes.current.add("job");
    if (payload.kind === "endpoints") changes.current.add("endpoints");
    // S14: an encrypted archive asks the owner for its password; the id is all this event carries.
    if (payload.kind === "archive-password" && "id" in payload && typeof payload.id === "string") setPasswordFor(payload.id);
    if (payload.kind === "dir" && "id" in payload) {
      if (left?.endpoint === payload.id) changes.current.add("left");
      if (right?.endpoint === payload.id) changes.current.add("right");
    }
    if (refreshTimer.current !== undefined || !changes.current.size) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      const next = new Set(changes.current);
      changes.current.clear();
      if (next.has("endpoints")) void refreshEndpoints();
      setRevisions((previous) => ({
        left: previous.left + Number(next.has("left")), right: previous.right + Number(next.has("right")),
        job: previous.job + Number(next.has("job")),
      }));
    }, 150);
  });
  useEffect(() => () => { clearTimeout(refreshTimer.current); refreshTimer.current = undefined; }, []);
  const inspect = useCallback(async (job: OperationJob) => {
    const identity = { jobId: job.id, digest: job.plan.digest };
    const [check, { grants }] = await Promise.all([
      rpc.call("plan_check", identity), rpc.call("agent_grants_list", {}),
    ]);
    const initiator = job.plan.initiator;
    return { check, grants: grants.filter((grant) => initiator.kind === "agent" && grant.threadId === initiator.threadId) };
  }, [rpc]);

  async function selectEndpoint(side: Side, endpoint: string) {
    const source = endpoints.find((item) => item.id === endpoint);
    const { path } = source?.provider === "sftp" && source.consent !== "granted"
      ? { path: { segments: [] } } : await rpc.call("endpoint_home", { endpoint });
    update((previous) => {
      const pane = previous[side];
      const index = pane.activeTab ?? 0;
      const tabs = pane.tabs.slice();
      tabs[index] = newTab(endpoint, path);
      return { ...previous, activePane: side, [side]: { tabs, activeTab: index } };
    });
  }
  const hostPath = (ref: ResourceRef) => {
    const endpoint = endpoints.find((item) => item.id === ref.endpoint);
    const path = nativePath(ref.path);
    return endpoint?.provider === "local" && endpoint.hostId && path !== null ? { hostId: endpoint.hostId, path } : null;
  };
  const preview = (ref: ResourceRef) => {
    const file = hostPath(ref);
    if (!file || !navigate.experimental_openFilePreview({ target: { kind: "host", ...file }, location: null })) {
      throw new CommanderError("unsupported", ru.noPreview);
    }
  };
  const readText = async (ref: ResourceRef) => {
    const file = hostPath(ref);
    const max = 128 * 1024;
    const unsupported = () => new CommanderError("unsupported", ru.compareLimit);
    if (!file) throw unsupported();
    const entry = await rpc.call("entry_stat", { ref });
    if (!entry || entry.kind !== "file" || BigInt(entry.size) > BigInt(max)) throw unsupported();
    const result = await sdk.files.read(file);
    if (result.sizeBytes > max) throw unsupported();
    let text;
    try {
      text = result.contentEncoding === "utf8" ? result.content :
        new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0)));
    } catch { throw unsupported(); }
    if (text.includes("\0")) throw unsupported();
    return text;
  };
  const terminal = async (ref: ResourceRef) => {
    const file = hostPath(ref);
    if (!file) throw new CommanderError("unsupported", ru.terminalUnavailable);
    if (threadId) {
      const env = environment ? await sdk.environments.get({ environmentId: environment }) : null;
      if (env?.hostId !== file.hostId || env.path !== file.path) {
        throw new CommanderError("unsupported", ru.terminalOpenPage);
      }
    }
    const session = await sdk.terminals.create({
      cols: 100, rows: 28, scope: threadId
        ? { kind: "thread", threadId }
        : { kind: "host_path", hostId: file.hostId, cwd: file.path },
    });
    if (!await navigate.experimental_openTerminal({ terminalId: session.id })) {
      await sdk.terminals.close({ terminalId: session.id, mode: "if-clean" });
      throw new CommanderError("unsupported", ru.terminalUnavailable);
    }
  };
  // Owner view: one file_read; a whole image comes at once, a larger one as chunks with one version.
  const loadView = async (ref: ResourceRef, mode: ViewKind | "auto") => {
    const first: WireView = await rpc.call("file_read", { ref, mode });
    return assembleImage(first,
      (offset, expect) => rpc.call("file_read", { ref, mode: "image", offset: offset.toString(), expect }));
  };
  const mutate = async (action: Promise<unknown>) => { const result = await action; refresh("job"); return result; };
  const identity = (job: OperationJob) => ({ jobId: job.id, digest: job.plan.digest });
  const retryUnfinished = async (job: OperationJob) => {
    const { plan, excluded } = await rpc.call("job_retry", { jobId: job.id });
    const count = excluded.reduce((sum, entry) => sum + entry.count, 0);
    const note: RetryNote | null = count ? { kind: "waiting", count } : plan ? null : { kind: "nothing" };
    setRetryNotes((notes) => {
      const next = { ...notes };
      if (note) next[job.id] = note;
      else delete next[job.id];
      return next;
    });
    if (!plan) return null;
    return rpc.call("plan_run", { planId: plan.id, digest: plan.digest });
  };
  // S13: the write tickets use the same queue and per-plan confirmation as other operations.
  const sync: NonNullable<ComponentProps<typeof Workspace>["sync"]> = {
    async estimate(paths) {
      const estimate = await rpc.call("scan_start", {
        kind: "dirs", ...paths, by: "sha256", mtimeToleranceMs: 0, limit: LIST_PAGE_MAX, estimateOnly: true,
      });
      if (!("estimateId" in estimate)) throw new CommanderError("internal", ru.sync.estimateFailed);
      return estimate;
    },
    create: (request, estimateId) => rpc.call("sync_create", { ...request, estimateId }),
    run: (plan) => mutate(rpc.call("plan_run", { planId: plan.id, digest: plan.digest })),
  };
  return <Workspace search={search} sync={sync} scans={scans} startingScans={startingScans} state={state} update={update} endpoints={endpoints} compact={compact} queue={queue} problem={problem}
    directories={{ left: leftDir, right: rightDir }} bindings={bindings}
    onBindings={(value) => {
      setBindings(value);
      try { localStorage.setItem(bindingsKey, JSON.stringify(value)); } catch { /* Current session still uses the mapping. */ }
    }}
    retryNotes={retryNotes} onEndpoint={selectEndpoint} onRefresh={refresh}
    onOpenArchive={async (source) => {
      const opened = await rpc.call("archive_open", { source });
      await refreshEndpoints();
      return { endpoint: opened.endpoint };
    }}
    passwordFor={passwordFor}
    onPassword={async (archiveId, password) => {
      await rpc.call("archive_password", { archiveId, password });
      setPasswordFor(null);
    }}
    onPasswordCancel={(archiveId) => {
      setPasswordFor(null);
      void rpc.call("archive_password_cancel", { archiveId }).catch(() => undefined);
    }}
    onAccess={async (endpoint) => {
      await rpc.call("sftp_request_access", { profileId: endpoint.id.slice("sftp:".length), level: "write" });
      await refreshEndpoints();
      refresh("left");
      refresh("right");
    }}
    onCreate={(input: PlanRequest) => rpc.call("plan_create", input)}
    onRun={(plan: OperationPlan) => mutate(rpc.call("plan_run", { planId: plan.id, digest: plan.digest }))}
    onInspect={inspect} onApprove={(job) => mutate(rpc.call("plan_approve", identity(job)))}
    onReject={(job) => mutate(rpc.call("plan_reject", identity(job)))}
    onReloadConflict={async (jobId) => {
      const fresh = await readConflictJob(rpc, jobId);
      refresh("job");
      return fresh;
    }}
    onDecide={async (job, action: ConflictAction, same) => {
      if (!job.pendingConflict) return;
      await mutate(rpc.call("job_decide", { jobId: job.id, conflictId: job.pendingConflict.id, action, applyTo: same ? "remaining_same_reason" : "this" }));
    }}
    onCancel={(job) => mutate(rpc.call("job_cancel", { jobId: job.id }))}
    onRetry={(job) => mutate(retryUnfinished(job))}
    onPreview={preview} onView={(ref, mode) => loadView(ref, mode)} onCompare={(source, target) => Promise.all([readText(source), readText(target)])}
    onTerminal={terminal} onOpenThread={(id) => navigate.toThread(id)} onOpenPage={() => navigate.toPluginPanel("commander")} />;
}

function ThreadTab({ threadId, environment }: ExperimentalThreadTabProps) {
  return <CommanderPage key={threadId + ":" + (environment?.id ?? "")} compact environment={environment?.id} threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "commander", path: "commander", title: "Commander", icon: "Folder", component: () => <CommanderPage /> });
  app.slots.experimental_tab({
    id: "commander", context: { kind: "thread" }, availability: "fixed", title: "Commander",
    icon: "Folder", layout: "flush", component: ThreadTab,
  });
});
