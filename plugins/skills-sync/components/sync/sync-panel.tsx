// The Skills Sync panel: what upstream changed since the pinned commit, and
// which of those changes the user wants to take. The host renders the panel
// title and gives the body no padding, so the scroll region and spacing below
// are ours.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "@/contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CatalogueSection } from "./catalogue-section";
import { ConflictDialog } from "./conflict-dialog";
import { ConflictMerge } from "./merge-flow";
import { Disclosure } from "./disclosure";
import { SkillDiff, diffKey, splitPatch, type DiffKind, type DiffState } from "./skill-diff";
import { SkillRow } from "./skill-row";
import {
  SECTIONS,
  defaultSelection,
  fetchAge,
  hasNothingLeftBehind,
  selectionOrder,
  shortSha,
  skillsIn,
  type Backup,
  type Merge,
  type Source,
  type Status,
} from "./model";
import { useSyncSignal } from "./use-sync-signal";

/** How often the "checked N minutes ago" line re-reads the clock. */
const AGE_TICK_MS = 30_000;

/** A merge transition, named by the skill it belongs to. Applies carry no `merge`. */
function isMergeSignal(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "merge" in payload;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SyncPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = useState<Readonly<Record<string, DiffState>>>({});
  // The single skill whose conflict the user is resolving, or null. One name,
  // never a set: this flow exists to make an overwrite a considered act.
  const [conflict, setConflict] = useState<string | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  // Agent-assisted merges, keyed by skill name. A missing entry reads as
  // "none": no merge has been started for that skill.
  const [merges, setMerges] = useState<Readonly<Record<string, Merge>>>({});
  const [mergeDiffs, setMergeDiffs] = useState<Readonly<Record<string, DiffState>>>({});
  // One name at a time, like the conflict dialog: merging is per skill.
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const mergeDiffsInFlight = useRef<Set<string>>(new Set());
  const requestGeneration = useRef(0);
  // Counted, not a boolean: a superseded check must not clear the pending
  // state of one that is still running.
  const refreshesInFlight = useRef(0);

  const settleRefresh = useCallback(() => {
    refreshesInFlight.current = Math.max(0, refreshesInFlight.current - 1);
    setChecking(refreshesInFlight.current > 0);
  }, []);

  const loadSources = useCallback(() => {
    setError(null);
    rpc.call("listSources", null).then((result) => {
      setSources(result.sources);
      setSourceId((current) => current ?? result.sources[0]?.id ?? null);
    }, (cause) => setError(message(cause)));
  }, [rpc]);

  useEffect(loadSources, [loadSources]);

  // The pin moves and files change under us on every apply, so a fresh status
  // invalidates every cached diff and the tick marks with it. `refresh` decides
  // whether the backend contacts the network: everything routine passes false
  // and reads the cached clone, and only an explicit "Check upstream" passes
  // true, because that call is slow and can fail.
  const loadStatus = useCallback(
    (id: string, refresh: boolean) => {
      const generation = ++requestGeneration.current;
      inFlight.current.clear();
      setError(null);
      if (refresh) {
        refreshesInFlight.current += 1;
        setChecking(true);
      }
      rpc.call("status", { sourceId: id, refresh }).then((next) => {
        if (refresh) settleRefresh();
        if (generation !== requestGeneration.current) return;
        // A diff started while this status request was pending belongs to the
        // old snapshot too. Advance the generation before exposing the new
        // status so those results cannot repopulate the cleared cache.
        requestGeneration.current += 1;
        inFlight.current.clear();
        setStatus(next);
        setSelected(new Set(defaultSelection(next)));
        setDiffs({});
        setMerges({});
        setMergeDiffs({});
        mergeDiffsInFlight.current.clear();
        setExpanded(new Set());
        setConflict(null);
      }, (cause) => {
        if (refresh) settleRefresh();
        if (generation !== requestGeneration.current) return;
        // Keep a failed refetch retryable even if a diff was started while it
        // was pending. Its result is stale once this refetch has settled.
        requestGeneration.current += 1;
        inFlight.current.clear();
        setError(message(cause));
      });
    },
    [rpc, settleRefresh],
  );

  useEffect(() => {
    if (sourceId === null) return;
    setStatus(null);
    setBackups([]);
    loadStatus(sourceId, false);
  }, [sourceId, loadStatus]);

  // Routine reload: something local changed and the cache already knows it.
  const refetch = useCallback(() => {
    if (sourceId !== null) loadStatus(sourceId, false);
  }, [sourceId, loadStatus]);

  // Anything the user presses expecting a new answer. Retry belongs here too:
  // a cached failure retried against the same cache fails the same way, which
  // is the trap this whole `refresh` flag was added to escape.
  const checkUpstream = useCallback(() => {
    if (sourceId !== null) loadStatus(sourceId, true);
  }, [sourceId, loadStatus]);

  // A diff is fetched once, on the first expand, and then kept: nothing about
  // it can change until the next status refetch clears the cache.
  const fetchDiff = useCallback(
    (name: string, kind: DiffKind, force = false) => {
      if (sourceId === null) return;
      const key = diffKey(name, kind);
      if (!force && inFlight.current.has(key)) return;
      const generation = requestGeneration.current;
      inFlight.current.add(key);
      setDiffs((current) => ({ ...current, [key]: { phase: "loading" } }));
      rpc.call("diff", { sourceId, name, kind }).then(
        (result) => {
          if (generation !== requestGeneration.current) return;
          inFlight.current.delete(key);
          setDiffs((current) => ({
            ...current,
            [key]: { phase: "ready", files: splitPatch(result.patch, name) },
          }));
        },
        (cause) => {
          if (generation !== requestGeneration.current) return;
          inFlight.current.delete(key);
          setDiffs((current) => ({
            ...current,
            [key]: { phase: "error", message: message(cause) },
          }));
        },
      );
    },
    [rpc, sourceId],
  );

  const openConflict = useCallback(
    (name: string) => {
      fetchDiff(name, "local");
      fetchDiff(name, "upstream");
      setConflict(name);
    },
    [fetchDiff],
  );

  /**
   * Re-read one skill's merge state. Failures are left silent on purpose: this
   * runs on a timer and on every status load, and a toast per tick would bury
   * the panel. The row simply keeps showing the last state it knew.
   */
  const refreshMerge = useCallback(
    (name: string) => {
      if (sourceId === null) return;
      const generation = requestGeneration.current;
      rpc.call("mergeState", { sourceId, name }).then(
        (next) => {
          if (generation !== requestGeneration.current) return;
          setMerges((current) => ({ ...current, [name]: next }));
        },
        () => undefined,
      );
    },
    [rpc, sourceId],
  );

  const fetchMergeDiff = useCallback(
    (name: string, force = false) => {
      if (sourceId === null) return;
      if (!force && mergeDiffsInFlight.current.has(name)) return;
      const generation = requestGeneration.current;
      mergeDiffsInFlight.current.add(name);
      setMergeDiffs((current) => ({ ...current, [name]: { phase: "loading" } }));
      rpc.call("mergeDiff", { sourceId, name }).then(
        (result) => {
          if (generation !== requestGeneration.current) return;
          setMergeDiffs((current) => ({
            ...current,
            [name]: { phase: "ready", files: splitPatch(result.patch, name) },
          }));
        },
        (cause) => {
          if (generation !== requestGeneration.current) return;
          mergeDiffsInFlight.current.delete(name);
          setMergeDiffs((current) => ({
            ...current,
            [name]: { phase: "error", message: message(cause) },
          }));
        },
      );
    },
    [rpc, sourceId],
  );

  // A merge started earlier outlives this panel, so every conflict is asked
  // once per status load whether one is already under way.
  const conflictNames = useMemo(
    () => (status === null ? [] : skillsIn(status, "dirty-conflict").map((s) => s.name)),
    [status],
  );
  useEffect(() => {
    for (const name of conflictNames) refreshMerge(name);
  }, [conflictNames, refreshMerge]);

  /**
   * React to whatever the backend says has changed.
   *
   * Merge progress arrives on the same channel as applies, so every signal
   * re-reads merge state. A merge signal stops there on purpose: a full status
   * reload clears the open rows and cached diffs, which would fold the very row
   * the user is watching the merge in. A signal published while the socket was
   * down is lost, and `useSyncSignal`'s refetch on reconnect is what catches
   * it, so a finished merge can never leave the panel stuck on "running".
   */
  const conflictNamesRef = useRef<string[]>(conflictNames);
  conflictNamesRef.current = conflictNames;
  const reload = useCallback(
    (payload?: unknown) => {
      for (const name of conflictNamesRef.current) refreshMerge(name);
      if (!isMergeSignal(payload)) refetch();
    },
    [refetch, refreshMerge],
  );
  useSyncSignal(reload);

  // A merge that has just become ready needs its diff fetched once.
  const readyKey = useMemo(
    () =>
      Object.entries(merges)
        .filter(([, merge]) => merge.state === "ready")
        .map(([name]) => name)
        .join("\n"),
    [merges],
  );
  useEffect(() => {
    if (readyKey === "") return;
    for (const name of readyKey.split("\n")) fetchMergeDiff(name);
  }, [readyKey, fetchMergeDiff]);

  const forgetMerge = useCallback((name: string) => {
    mergeDiffsInFlight.current.delete(name);
    setMerges((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    setMergeDiffs((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  }, []);

  /** Hand one conflicted skill to an agent. Writes nothing by itself. */
  const startMerge = useCallback(
    async (name: string) => {
      if (sourceId === null) return;
      setMergeBusy(name);
      try {
        const next = await rpc.call("mergeStart", { sourceId, name });
        setMerges((current) => ({ ...current, [name]: next }));
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setMergeBusy(null);
      }
    },
    [rpc, sourceId],
  );

  /**
   * The only merge call that touches the skills folder. It is destructive in
   * the same way the overwrite is, so the backup path it returns is shown in
   * the same durable note rather than in a toast that scrolls away.
   */
  const acceptMerge = useCallback(
    async (name: string) => {
      if (sourceId === null) return;
      setMergeBusy(name);
      try {
        const result = await rpc.call("mergeAccept", { sourceId, name });
        setBackups([{ name, path: result.backup }]);
        toast.success(`${name} now has the merged version.`);
        forgetMerge(name);
        refetch();
      } catch (cause) {
        toast.error(`${name} was not merged: ${message(cause)}`);
      } finally {
        setMergeBusy(null);
      }
    },
    [rpc, sourceId, forgetMerge, refetch],
  );

  /**
   * Stop a running merge. Safe by construction: nothing has reached the skills
   * folder yet, so the skill simply goes back to being an unresolved conflict.
   *
   * A cancel that could not stop the agent throws. The merge is deliberately
   * NOT forgotten in that case: the thread is still there, still shown, and the
   * message says so, instead of the panel claiming a cancel that did not fully
   * happen.
   */
  const cancelMerge = useCallback(
    async (name: string) => {
      if (sourceId === null) return;
      setMergeBusy(name);
      try {
        await rpc.call("mergeCancel", { sourceId, name });
        forgetMerge(name);
        toast.success(`Merge cancelled. Your ${name} is unchanged.`);
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setMergeBusy(null);
      }
    },
    [rpc, sourceId, forgetMerge],
  );

  /** Throw the staged merge away. Nothing was ever written, so nothing reloads. */
  const discardMerge = useCallback(
    async (name: string) => {
      if (sourceId === null) return;
      setMergeBusy(name);
      try {
        await rpc.call("mergeDiscard", { sourceId, name });
        forgetMerge(name);
        toast.success(`Merge discarded. Your ${name} is unchanged.`);
      } catch (cause) {
        toast.error(message(cause));
      } finally {
        setMergeBusy(null);
      }
    },
    [rpc, sourceId, forgetMerge],
  );

  const toggleExpanded = useCallback(
    (name: string, kinds: DiffKind[]) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else {
          next.add(name);
          for (const kind of kinds) fetchDiff(name, kind);
        }
        return next;
      });
    },
    [fetchDiff],
  );

  const setChecked = useCallback((names: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const name of names) {
        if (checked) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }, []);

  const selectedNames = useMemo(() => {
    if (status === null) return [];
    // Report in status order, not click order, so `apply` gets a stable list.
    return selectionOrder(status, selected);
  }, [status, selected]);

  const apply = useCallback(async () => {
    if (status === null || sourceId === null || selectedNames.length === 0) return;
    setBusy(true);
    try {
      const result = await rpc.call("apply", {
        sourceId,
        names: selectedNames,
        bumpMarker: hasNothingLeftBehind(status, selected),
        allowConflictOverwrite: false,
      });
      if (result.failed.length > 0) {
        toast.error(
          `Applied ${result.applied.length}, ${result.failed.length} failed: ` +
            result.failed.map((entry) => `${entry.name} (${entry.error})`).join(", "),
        );
      } else if (result.markerRefusal === null) {
        toast.success(
          `Applied ${result.applied.length} ${result.applied.length === 1 ? "skill" : "skills"}` +
            (result.marker === null ? "" : `; pinned at ${shortSha(result.marker)}`),
        );
      } else {
        toast.warning(
          `Applied ${result.applied.length} ${result.applied.length === 1 ? "skill" : "skills"}, ` +
            `but the pin did not move: ${result.markerRefusal}`,
        );
      }
      if (result.failed.length > 0 && result.markerRefusal !== null) {
        toast.warning(`The pin did not move: ${result.markerRefusal}`);
      }
      refetch();
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc, status, sourceId, selectedNames, selected, refetch]);

  /**
   * Take upstream for one conflicted skill, dropping the user's edit. The only
   * `allowConflictOverwrite: true` in the plugin, and it always carries exactly
   * one name: the dialog it comes from can only be opened from a single row.
   */
  const overwriteConflict = useCallback(async () => {
    if (conflict === null || sourceId === null) return;
    const name = conflict;
    setBusy(true);
    try {
      const result = await rpc.call("apply", {
        sourceId,
        names: [name],
        // Other work is usually still outstanding, so the pin stays put; the
        // next ordinary Apply moves it once nothing is left behind.
        bumpMarker: false,
        allowConflictOverwrite: true,
      });
      const failure = result.failed.find((entry) => entry.name === name);
      if (failure !== undefined) {
        toast.error(`${name} was not replaced: ${failure.error}`);
      } else {
        // Optional in the contract: a backend that makes no backup says nothing,
        // and the panel must not claim a path it was not given.
        setBackups(result.backups ?? []);
        toast.success(`${name} now matches upstream.`);
      }
      setConflict(null);
      refetch();
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc, conflict, sourceId, refetch]);

  if (error !== null && status === null) {
    return (
      <Frame>
        <div
          role="alert"
          className="rounded-lg border border-border bg-card p-4 text-sm"
        >
          <p className="text-destructive">{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Retrying against the same cache reproduces a cached failure, so
                this asks upstream. It is the only button here; a separate
                "Check upstream" would now do exactly the same thing. */}
            <Button
              variant="secondary"
              onClick={() => (sources === null ? loadSources() : checkUpstream())}
              disabled={checking}
            >
              {checking ? (
                <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
              ) : null}
              Retry
            </Button>
          </div>
          {sources === null ? null : (
            <p className="mt-2 text-xs text-muted-foreground">
              Retry asks upstream again rather than reading the cache.
            </p>
          )}
        </div>
      </Frame>
    );
  }

  if (sources !== null && sources.length === 0) {
    return (
      <Frame>
        <Note>No upstream sources are configured for this plugin.</Note>
      </Frame>
    );
  }

  if (status === null) {
    return (
      <Frame>
        <Note>Comparing installed skills against upstream…</Note>
      </Frame>
    );
  }

  const nothingToDo = status.skills.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
          {sources !== null && sources.length > 1 ? (
            <SourcePicker
              sources={sources}
              value={sourceId}
              onChange={setSourceId}
            />
          ) : null}

          <StatusHeader
            status={status}
            checking={checking}
            onCheckUpstream={checkUpstream}
          />

          <BackupNote backups={backups} onDismiss={() => setBackups([])} />

          {error !== null ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {nothingToDo ? (
            <Note className="mt-4">Up to date with {shortSha(status.head)}.</Note>
          ) : (
            <div className="mt-4 space-y-5">
              {SECTIONS.map((section) => (
                <Section
                  key={section.bucket}
                  section={section}
                  status={status}
                  selected={selected}
                  onCheckedChange={setChecked}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  diffs={diffs}
                  onRetryDiff={fetchDiff}
                  onResolveConflict={openConflict}
                  merges={merges}
                  mergeDiffs={mergeDiffs}
                  mergeBusy={mergeBusy}
                  onStartMerge={startMerge}
                  onAcceptMerge={acceptMerge}
                  onCancelMerge={cancelMerge}
                  onDiscardMerge={discardMerge}
                  onRetryMergeDiff={fetchMergeDiff}
                  onForgetMerge={forgetMerge}
                />
              ))}
            </div>
          )}

          <CatalogueSection
            catalogue={status.catalogue}
            selected={selected}
            onCheckedChange={setChecked}
          />

          <ForeignNote foreign={status.foreign} />
        </div>
      </div>

      <ConflictDialog
        name={conflict}
        diffs={diffs}
        onRetryDiff={fetchDiff}
        busy={busy}
        onCancel={() => setConflict(null)}
        onConfirm={() => void overwriteConflict()}
      />

      <div className="sticky bottom-0 border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 md:px-5">
          <span className="text-xs text-muted-foreground">
            {selectedNames.length === 0
              ? "Nothing selected."
              : hasNothingLeftBehind(status, selected)
                ? `The pin will move to ${shortSha(status.head)}.`
                : "The pin stays where it is until nothing is left behind."}
          </span>
          <Button
            onClick={() => void apply()}
            disabled={busy || selectedNames.length === 0}
          >
            {busy ? (
              <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
            ) : null}
            Apply {selectedNames.length}{" "}
            {selectedNames.length === 1 ? "skill" : "skills"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where the replaced version went. This outlives the toast on purpose: a path
 * the user needs to go and read is the one thing they must not miss.
 */
function BackupNote({
  backups,
  onDismiss,
}: {
  backups: Backup[];
  onDismiss: () => void;
}) {
  if (backups.length === 0) return null;
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">
          Your old version was saved.
        </p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="mt-1 space-y-0.5">
        {backups.map((backup) => (
          <li key={backup.path} className="text-xs text-muted-foreground">
            <span className="font-mono">{backup.name}</span>
            {" → "}
            <span className="font-mono break-all">{backup.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {children}
      </div>
    </div>
  );
}

function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SourcePicker({
  sources,
  value,
  onChange,
}: {
  sources: Source[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Upstream source">
      {sources.map((source) => (
        <Button
          key={source.id}
          role="tab"
          aria-selected={source.id === value}
          variant={source.id === value ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onChange(source.id)}
        >
          {source.id}
        </Button>
      ))}
    </div>
  );
}

/**
 * Pinned SHA, upstream HEAD, the commits between them — and, next to all three,
 * when that comparison was last measured. Without the age line a SHA read out
 * of a week-old cache looks exactly like a live one.
 */
function StatusHeader({
  status,
  checking,
  onCheckUpstream,
}: {
  status: Status;
  checking: boolean;
  onCheckUpstream: () => void;
}) {
  const [open, setOpen] = useState(false);
  const now = useClock();
  const count = status.commits.length;
  const age = fetchAge(status.fetchedAt, now, status.autoFetchHours);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <code className="font-mono text-xs">{shortSha(status.pinned)}</code>
          <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" aria-hidden />
          <code className="font-mono text-xs">{shortSha(status.head)}</code>
          <span className="text-muted-foreground">
            {count} {count === 1 ? "commit" : "commits"} behind
          </span>
          <span
            className={cn(
              "text-xs",
              age.stale ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {age.label}
          </span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onCheckUpstream}
          disabled={checking}
        >
          <Icon
            name={checking ? "Spinner" : "ArrowReloadHorizontal"}
            className={cn("size-4", checking && "animate-spin")}
            aria-hidden
          />
          {checking ? "Checking…" : "Check upstream"}
        </Button>
      </div>
      {age.stale ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Those numbers come from the last check, not from upstream right now.
        </p>
      ) : null}
      {count === 0 ? null : (
        <Disclosure
          className="mt-2"
          open={open}
          onOpenChange={setOpen}
          summary={open ? "Hide commits" : "Show what changed upstream"}
        >
          <ul className="space-y-1 border-l border-border pl-3">
            {status.commits.map((commit) => (
              <li key={commit.sha} className="flex gap-2 text-xs">
                <code className="shrink-0 font-mono text-muted-foreground">
                  {shortSha(commit.sha)}
                </code>
                <span className="min-w-0 flex-1">{commit.subject}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** Re-reads the clock so "checked just now" does not stay true for an hour. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ForeignNote({ foreign }: { foreign: string[] }) {
  const [open, setOpen] = useState(false);
  if (foreign.length === 0) return null;
  return (
    <Disclosure
      className="mt-5"
      open={open}
      onOpenChange={setOpen}
      summary={`${foreign.length} other ${foreign.length === 1 ? "skill" : "skills"} from different sources, never touched by this plugin`}
    >
      <ul className="flex flex-wrap gap-x-3 gap-y-1 pl-5 font-mono text-xs text-muted-foreground">
        {foreign.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** Which diffs a row shows: a conflict needs both sides to be mergeable. */
function diffKindsFor(bucket: Status["skills"][number]["bucket"]): DiffKind[] {
  if (bucket === "dirty-conflict") return ["upstream", "local"];
  if (bucket === "dirty-only") return ["local"];
  return ["upstream"];
}

function Section({
  section,
  status,
  selected,
  onCheckedChange,
  expanded,
  onToggleExpanded,
  diffs,
  onRetryDiff,
  onResolveConflict,
  merges,
  mergeDiffs,
  mergeBusy,
  onStartMerge,
  onAcceptMerge,
  onCancelMerge,
  onDiscardMerge,
  onRetryMergeDiff,
  onForgetMerge,
}: {
  section: (typeof SECTIONS)[number];
  status: Status;
  selected: ReadonlySet<string>;
  onCheckedChange: (names: string[], checked: boolean) => void;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (name: string, kinds: DiffKind[]) => void;
  diffs: Readonly<Record<string, DiffState>>;
  onRetryDiff: (name: string, kind: DiffKind, force?: boolean) => void;
  onResolveConflict: (name: string) => void;
  merges: Readonly<Record<string, Merge>>;
  mergeDiffs: Readonly<Record<string, DiffState>>;
  mergeBusy: string | null;
  onStartMerge: (name: string) => void;
  onAcceptMerge: (name: string) => void;
  onCancelMerge: (name: string) => void;
  onDiscardMerge: (name: string) => void;
  onRetryMergeDiff: (name: string, force?: boolean) => void;
  onForgetMerge: (name: string) => void;
}) {
  const skills = skillsIn(status, section.bucket);
  const [collapsed, setCollapsed] = useState(section.collapsedByDefault);
  if (skills.length === 0) return null;
  const names = skills.map((skill) => skill.name);
  const allChecked = names.every((name) => selected.has(name));

  return (
    <section aria-label={section.title}>
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{section.title}</h3>
        <span className="text-xs text-muted-foreground">{skills.length}</span>
        {/* Only a section whose rows can be ticked gets a select-all. */}
        {section.selectable && section.bucket === "clean" ? (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={allChecked}
              onCheckedChange={(next) => onCheckedChange(names, next === true)}
              aria-label="Select all clean updates"
            />
            Select all
          </label>
        ) : null}
      </header>
      <p className="mt-0.5 text-xs text-muted-foreground">{section.blurb}</p>
      {section.collapsedByDefault ? (
        <Disclosure
          className="mt-2"
          open={!collapsed}
          onOpenChange={(open) => setCollapsed(!open)}
          summary={collapsed ? "Show them anyway" : "Hide"}
        >
          <SkillList
            skills={skills}
            section={section}
            selected={selected}
            onCheckedChange={onCheckedChange}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            diffs={diffs}
            onRetryDiff={onRetryDiff}
            onResolveConflict={onResolveConflict}
            merges={merges}
            mergeDiffs={mergeDiffs}
            mergeBusy={mergeBusy}
            onStartMerge={onStartMerge}
            onAcceptMerge={onAcceptMerge}
            onCancelMerge={onCancelMerge}
            onDiscardMerge={onDiscardMerge}
            onRetryMergeDiff={onRetryMergeDiff}
            onForgetMerge={onForgetMerge}
          />
        </Disclosure>
      ) : (
        <div className="mt-2">
          <SkillList
            skills={skills}
            section={section}
            selected={selected}
            onCheckedChange={onCheckedChange}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            diffs={diffs}
            onRetryDiff={onRetryDiff}
            onResolveConflict={onResolveConflict}
            merges={merges}
            mergeDiffs={mergeDiffs}
            mergeBusy={mergeBusy}
            onStartMerge={onStartMerge}
            onAcceptMerge={onAcceptMerge}
            onCancelMerge={onCancelMerge}
            onDiscardMerge={onDiscardMerge}
            onRetryMergeDiff={onRetryMergeDiff}
            onForgetMerge={onForgetMerge}
          />
        </div>
      )}
    </section>
  );
}

function SkillList({
  skills,
  section,
  selected,
  onCheckedChange,
  expanded,
  onToggleExpanded,
  diffs,
  onRetryDiff,
  onResolveConflict,
  merges,
  mergeDiffs,
  mergeBusy,
  onStartMerge,
  onAcceptMerge,
  onCancelMerge,
  onDiscardMerge,
  onRetryMergeDiff,
  onForgetMerge,
}: {
  skills: Status["skills"];
  section: (typeof SECTIONS)[number];
  selected: ReadonlySet<string>;
  onCheckedChange: (names: string[], checked: boolean) => void;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (name: string, kinds: DiffKind[]) => void;
  diffs: Readonly<Record<string, DiffState>>;
  onRetryDiff: (name: string, kind: DiffKind, force?: boolean) => void;
  onResolveConflict: (name: string) => void;
  merges: Readonly<Record<string, Merge>>;
  mergeDiffs: Readonly<Record<string, DiffState>>;
  mergeBusy: string | null;
  onStartMerge: (name: string) => void;
  onAcceptMerge: (name: string) => void;
  onCancelMerge: (name: string) => void;
  onDiscardMerge: (name: string) => void;
  onRetryMergeDiff: (name: string, force?: boolean) => void;
  onForgetMerge: (name: string) => void;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {skills.map((skill) => {
        const kinds = diffKindsFor(skill.bucket);
        return (
          <SkillRow
            key={skill.name}
            skill={skill}
            selectable={section.selectable}
            checked={selected.has(skill.name)}
            onCheckedChange={(checked) => onCheckedChange([skill.name], checked)}
            expanded={expanded.has(skill.name)}
            onToggleExpanded={() => onToggleExpanded(skill.name, kinds)}
          >
            {skill.bucket === "dirty-conflict" ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Applying this would overwrite your edit, so this plugin will
                  not do it. Read both diffs below, then pick a way out.
                </p>
                <ConflictMerge
                  name={skill.name}
                  merge={merges[skill.name]}
                  diff={mergeDiffs[skill.name]}
                  busy={mergeBusy === skill.name}
                  onStart={() => onStartMerge(skill.name)}
                  onAccept={() => onAcceptMerge(skill.name)}
                  onCancel={() => onCancelMerge(skill.name)}
                  onDiscard={() => onDiscardMerge(skill.name)}
                  onRetryDiff={() => onRetryMergeDiff(skill.name, true)}
                  onDismissFailure={() => onForgetMerge(skill.name)}
                />
                <p className="text-xs text-muted-foreground">
                  Or give up your edit and take upstream as it is:
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onResolveConflict(skill.name)}
                >
                  Replace {skill.name} with upstream…
                </Button>
              </div>
            ) : null}
            {kinds.map((kind) => (
              <SkillDiff
                key={kind}
                label={kind === "upstream" ? "Upstream changes" : "Your changes"}
                state={diffs[diffKey(skill.name, kind)]}
                onRetry={() => onRetryDiff(skill.name, kind, true)}
              />
            ))}
          </SkillRow>
        );
      })}
    </ul>
  );
}
