import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { ConflictAction, Entry, OperationJob, OperationPlan, ResourceRef } from "../core/model.ts";
import { displayPath, join, NameSegment, parent, parsePosix, samePath, type ResourcePath } from "../core/path.ts";
import type { AgentGrant, SavedUiScan, UiState } from "../core/wire/rpc.ts";
import { CompareView, type ScanActions, type ScanSubject } from "./compare-view.tsx";
import type { ViewKind, ViewResult } from "../core/preview.ts";
import { ConflictDialog, Modal, PlanDialog, TextDialog } from "./dialogs.tsx";
import { BatchRenameDialog } from "./batch-rename.tsx";
import type { RenamePattern } from "../core/rename-pattern.ts";
import { chord, findShortcut, shortcuts, shortcutText, type KeyBindings, type Shortcut } from "./keyboard.ts";
import { activeTab, currentRef, keyOf, nameOf, nativePath, otherSide, problemOf, selectionInfo, shortPath, sides, visibleEntries,
  type Directory, type EndpointView, type PlanCheck, type PlanRequest, type Problem, type Side, type Tab } from "./model.ts";
import { Pane, ProblemLine, rowHeight, upKey } from "./pane.tsx";
import { Queue, type QueueProps, type RetryNote } from "./queue.tsx";
import { ru } from "./strings.ts";
import { Viewer } from "./viewer.tsx";

type ConflictView = { kind: "conflict"; job: OperationJob };
type Cursor = { key: string; index: number; explicit: boolean };
type DialogState = { kind: "plan"; plan: OperationPlan; job?: OperationJob }
  | ConflictView
  | { kind: "cancel"; job: OperationJob; returnTo?: ConflictView }
  | { kind: "text"; title: string; label: string; initial?: string; submit: (value: string) => void }
  | { kind: "scan"; subject: ScanSubject }
  | { kind: "content"; source: string; target: string; returnTo: ConflictView }
  // S12: батч-переименование выбранной пачки; sources — настоящие ссылки на выбранные объекты.
  | { kind: "batch-rename"; entries: Entry[]; sources: ResourceRef[]; caseSensitive: boolean }
  | { kind: "view"; ref: ResourceRef; title: string; mode: ViewKind | "auto"; result: ViewResult | null; problem: Problem | null }
  | { kind: "settings" };

export interface WorkspaceProps {
  state: UiState;
  update: (change: (state: UiState) => UiState) => void;
  endpoints: EndpointView[];
  directories: Record<Side, Directory | undefined>;
  queue: Pick<QueueProps, "jobs" | "error" | "loading">;
  problem: Problem | null;
  compact: boolean;
  bindings: KeyBindings;
  onBindings: (bindings: KeyBindings) => void;
  onEndpoint: (side: Side, endpoint: string) => Promise<void>;
  onRefresh: (side: Side) => void;
  onAccess: (endpoint: EndpointView) => Promise<void>;
  onCreate: (input: PlanRequest) => Promise<OperationPlan>;
  onRun: (plan: OperationPlan) => Promise<unknown>;
  onInspect: (job: OperationJob) => Promise<{ check: PlanCheck; grants: AgentGrant[] }>;
  onApprove: (job: OperationJob) => Promise<unknown>;
  onReject: (job: OperationJob) => Promise<unknown>;
  onReloadConflict: (jobId: string) => Promise<OperationJob | null>;
  onDecide: (job: OperationJob, action: ConflictAction, same: boolean) => Promise<unknown>;
  onCancel: (job: OperationJob) => Promise<unknown>;
  /** S17: повтор невыполненного; хост создаёт план повтора и запускает его. */
  onRetry: (job: OperationJob) => Promise<unknown>;
  /** S17: the last retry result by job id, shown on the queue card. */
  retryNotes: Record<string, RetryNote>;
  onPreview: (ref: ResourceRef) => void;
  scans: ScanActions;
  startingScans: ReadonlySet<ScanSubject["kind"]>;
  onView: (ref: ResourceRef, mode: ViewKind | "auto") => Promise<ViewResult>;
  onCompare: (source: ResourceRef, target: ResourceRef) => Promise<[string, string]>;
  onTerminal: (ref: ResourceRef) => Promise<void>;
  onOpenThread: (threadId: string) => void;
  onOpenPage: () => void;
}

const actions = [
  { key: "preview", icon: "Eye" }, { key: "edit", icon: "Edit" }, { key: "copy", icon: "Copy" },
  { key: "move", icon: "MoveTo" }, { key: "mkdir", icon: "FolderPlus" }, { key: "remove", icon: "Trash2" },
] as const;
const noEntries: Entry[] = [];

function savedScan(state: UiState, subject: ScanSubject): SavedUiScan | undefined {
  const sameRef = (a: ResourceRef, b: ResourceRef) => a.endpoint === b.endpoint && samePath(a.path, b.path, true);
  if (subject.kind === "checksum" && state.lastChecksum && sameRef(subject.file.ref, state.lastChecksum.request.ref)) {
    return state.lastChecksum;
  }
  const compare = state.lastComparison;
  if (subject.kind === "dirs" && compare
    && sameRef(subject.left.ref, compare.request.left) && sameRef(subject.right.ref, compare.request.right)) return compare;
}

function maskMatcher(mask: string) {
  const pattern = Array.from(mask);
  return (entry: Entry) => {
    const text = Array.from("t" in entry.name ? entry.name.t : nameOf(entry.name));
    let i = 0, j = 0, star = -1, resume = 0;
    while (i < text.length) {
      if (pattern[j] === "?" || pattern[j] === text[i] && pattern[j] !== "*") { i++; j++; }
      else if (pattern[j] === "*") { star = j++; resume = i; }
      else if (star !== -1) { j = star + 1; i = ++resume; }
      else return false;
    }
    while (pattern[j] === "*") j++;
    return j === pattern.length;
  };
}
function filterAndSort(directory: Directory | undefined, tab: Tab | undefined) {
  return directory && tab ? visibleEntries(directory.entries, tab) : noEntries;
}

function closestRow(previous: Entry[], current: Entry[], position: Cursor) {
  const visible = new Map(current.map((entry, index) => [keyOf(entry.name), index]));
  const at = previous.findIndex((entry) => keyOf(entry.name) === position.key);
  if (at >= 0) {
    for (let distance = 1; distance < previous.length; distance++) {
      for (const neighbor of [previous[at + distance], previous[at - distance]]) {
        const index = neighbor ? visible.get(keyOf(neighbor.name)) : undefined;
        if (index !== undefined) return index;
      }
    }
  }
  return Math.min(position.index, current.length - 1);
}

export function Workspace(props: WorkspaceProps) {
  const { state, update, endpoints, directories, compact, bindings } = props;
  const root = useRef<HTMLDivElement>(null);
  const queueToggle = useRef<HTMLButtonElement>(null);
  const focusQueue = useRef(false);
  const toolbar = useRef<HTMLElement>(null);
  const queueId = useId();
  const [narrowQueue, setNarrowQueue] = useState(false);
  const [width, setWidth] = useState<number>();
  const wide = !compact && (width === undefined || width >= 1040);
  const queueOpen = wide ? state.inspectorCollapsed !== true : narrowQueue;
  const [cursor, setCursor] = useState<Partial<Record<Side, Cursor>>>({});
  const previousRows = useRef<Record<Side, Entry[]>>({ left: [], right: [] });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [same, setSame] = useState(false);
  const [retryConflict, setRetryConflict] = useState<{ view: ConflictView; problem: Problem } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const focusReturn = useRef<HTMLElement | null>(null);
  const focusScanPanel = useRef(false);
  const conflictFocus = useRef<{ jobId: string; conflictId: string; jobs: typeof props.queue.jobs } | null>(null);
  useLayoutEffect(() => {
    if (!root.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const leftGrid = useRef<HTMLDivElement>(null), rightGrid = useRef<HTMLDivElement>(null);
  const grids = { left: leftGrid, right: rightGrid };
  const side = state.activePane, opposite = otherSide(side);
  const left = activeTab(state, "left"), right = activeTab(state, "right");
  const tabs = { left, right }, tab = tabs[side], destination = tabs[opposite];
  const leftEntries = useMemo(() => filterAndSort(directories.left, left), [directories.left, left?.sort, left?.filter]);
  const rightEntries = useMemo(() => filterAndSort(directories.right, right), [directories.right, right?.sort, right?.filter]);
  const all = { left: leftEntries, right: rightEntries }, entries = all[side];
  const endpointsBySide = { left: endpoints.find((item) => item.id === left?.endpoint), right: endpoints.find((item) => item.id === right?.endpoint) };
  const endpoint = endpointsBySide[side], target = endpointsBySide[opposite];
  const itemAtCursor = entries.find((entry) => keyOf(entry.name) === cursor[side]?.key);
  const current = cursor[side]?.explicit ? itemAtCursor : undefined;
  useLayoutEffect(() => {
    for (const pane of sides) {
      const position = cursor[pane], value = tabs[pane], directory = directories[pane];
      if (!value || !directory || directory.loading || directory.error) continue;
      const rows = all[pane], above = parent(value.path), previous = previousRows.current[pane];
      previousRows.current[pane] = rows;
      if (!position) {
        if (above) setCursor((previous) => ({ ...previous, [pane]: { key: upKey, index: 0, explicit: true } }));
        continue;
      }
      if (position.key === upKey && above || rows.some((entry) => keyOf(entry.name) === position.key)) continue;
      const index = closestRow(previous, rows, position);
      const next = rows[index];
      const replacement = next ? { key: keyOf(next.name), index, explicit: false }
        : above ? { key: upKey, index: 0, explicit: false } : undefined;
      setCursor((previous) => ({ ...previous, [pane]: replacement }));
      if (replacement) revealCursor(pane, next ? index + Number(!!above) : 0);
    }
  }, [leftEntries, rightEntries, directories.left?.loading, directories.right?.loading, cursor]);
  const targetReady = !!target && !target.readOnly && !directories[opposite]?.loading && !directories[opposite]?.error;
  const ready = !!endpoint && !directories[side]?.error && !directories[side]?.loading;
  const selectedNames = useMemo(() => {
    if (!tab?.selection.length || !directories[side]) return [];
    const existing = new Set(directories[side].entries.map((entry) => keyOf(entry.name)));
    return tab.selection.filter((name) => existing.has(keyOf(name)));
  }, [tab?.selection, directories[side]]);
  const selected = cursor[side]?.key !== upKey && (selectedNames.length > 0 || !!current);
  const can: Record<string, boolean> = {
    preview: ready && current?.kind !== "dir" && !!current && "t" in current.name && !!tab,
    copy: ready && targetReady && selected, move: ready && targetReady && selected && !endpoint?.readOnly,
    mkdir: ready && !endpoint?.readOnly, remove: ready && selected && !endpoint?.readOnly,
    rename: ready && !!current && !endpoint?.readOnly,
    terminal: !!ready && endpoint?.provider === "local" && !!endpoint.hostId && !!tab && nativePath(tab.path) !== null,
  };
  can.edit = ready && endpoint?.provider === "local" && !!endpoint.hostId && current?.kind !== "dir" && !!current &&
    "t" in current.name && !!tab && nativePath(tab.path) !== null;
  useLayoutEffect(() => {
    const bar = toolbar.current;
    if (!bar) return;
    const fit = () => {
      bar.dataset.density = "full";
      if (bar.scrollWidth <= bar.clientWidth) return;
      bar.dataset.density = "labels";
      if (bar.scrollWidth > bar.clientWidth) bar.dataset.density = "keys";
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bindings, compact, endpoint?.provider]);
  useLayoutEffect(() => {
    if (!queueOpen || !focusQueue.current) return;
    focusQueue.current = false;
    root.current?.querySelector<HTMLButtonElement>("[data-close-queue]")?.focus({ preventScroll: true });
  }, [queueOpen]);
  const activeJob = dialog && "job" in dialog && dialog.job
    ? props.queue.jobs.find((job): job is OperationJob => job.id === dialog.job?.id && "plan" in job) : null;
  useLayoutEffect(() => {
    if (dialog) return;
    if (focusScanPanel.current) {
      focusScanPanel.current = false;
      focusReturn.current = null;
      grids[side].current?.focus({ preventScroll: true });
      return;
    }
    const pending = conflictFocus.current;
    if (pending) {
      if (pending.jobs === props.queue.jobs && !props.queue.error) return;
      const oldIndex = pending.jobs.findIndex((job) => job.id === pending.jobId);
      const updatedIndex = props.queue.jobs.findIndex((job) => job.id === pending.jobId);
      const start = Math.max(0, updatedIndex < 0 ? oldIndex : updatedIndex);
      const ordered = [...props.queue.jobs.slice(start), ...props.queue.jobs.slice(0, start)];
      const nextId = ordered.find((job): job is OperationJob => "plan" in job && job.state === "awaiting_decision"
        && !!job.pendingConflict && job.pendingConflict.id !== pending.conflictId)?.pendingConflict?.id;
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-conflict-id]") ?? []);
      const next = nextId ? buttons.find((button) => button.dataset.conflictId === nextId
        && getComputedStyle(button).visibility !== "hidden") : undefined;
      if (nextId && !next && !queueOpen) {
        if (wide) update((previous) => ({ ...previous, inspectorCollapsed: false }));
        else setNarrowQueue(true);
        return;
      }
      conflictFocus.current = null;
      focusReturn.current = null;
      queueMicrotask(() => {
        if (next?.isConnected) {
          next.scrollIntoView?.({ block: "nearest" });
          next.focus({ preventScroll: true });
          if (document.activeElement === next) return;
        }
        const first = all[side][0];
        if (!cursor[side] && first) {
          setCursor((previous) => ({ ...previous, [side]: { key: keyOf(first.name), index: 0, explicit: false } }));
          revealCursor(side, Number(!!(tab && parent(tab.path))));
        }
        grids[side].current?.focus({ preventScroll: true });
      });
      return;
    }
    if (!focusReturn.current) return;
    const previous = focusReturn.current;
    focusReturn.current = null;
    queueMicrotask(() => {
      if (previous.isConnected) previous.focus({ preventScroll: true });
      else grids[side].current?.focus({ preventScroll: true });
    });
  }, [dialog, props.queue.jobs, props.queue.error, queueOpen, side]);
  const close = () => { setDialog(null); setProblem(null); };
  function goBack(returnTo: ConflictView) {
    void perform(async () => {
      let fresh: OperationJob | null;
      try {
        fresh = await props.onReloadConflict(returnTo.job.id);
      } catch (error) {
        close();
        setRetryConflict({ view: returnTo, problem: problemOf(error) });
        return;
      }
      setRetryConflict(null);
      if (fresh?.pendingConflict && fresh.pendingConflict.id === returnTo.job.pendingConflict?.id) {
        if (!dialog) {
          const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-conflict-id]") ?? []);
          focusReturn.current = buttons.find((button) => button.dataset.conflictId === fresh.pendingConflict?.id)
            ?? queueToggle.current;
        }
        setDialog({ kind: "conflict", job: fresh });
      } else {
        close();
        setNotice(ru.conflictEnded);
      }
    });
  }
  function decide(job: OperationJob, action: ConflictAction, apply: boolean) {
    const conflict = job.pendingConflict;
    if (!conflict) return;
    const previous = props.queue.jobs;
    void perform(() => props.onDecide(job, action, apply), () => {
      conflictFocus.current = { jobId: job.id, conflictId: conflict.id, jobs: previous };
      setRetryConflict((retry) => retry?.view.job.pendingConflict?.id === conflict.id ? null : retry);
      close();
    });
  }
  function toggleQueue() {
    if (!queueOpen) focusQueue.current = true;
    if (wide) update((previous) => ({ ...previous, inspectorCollapsed: queueOpen }));
    else setNarrowQueue(!queueOpen);
    if (queueOpen) queueMicrotask(() => queueToggle.current?.focus({ preventScroll: true }));
  }
  const open = (next: DialogState) => {
    if (!dialog) focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProblem(null);
    setNotice(null);
    if (!dialog) setRetryConflict(null);
    if (next.kind === "conflict") setSame(false);
    setDialog(next);
  };
  async function perform(action: () => Promise<unknown>, completed?: () => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try { await action(); completed?.(); }
    catch (error) { setProblem(problemOf(error)); }
    finally { running.current = false; setBusy(false); }
  }
  function setPane(pane: Side) {
    update((previous) => previous.activePane === pane ? previous : { ...previous, activePane: pane });
  }
  function patch(pane: Side, change: (tab: Tab) => Tab) {
    update((previous) => {
      const value = activeTab(previous, pane), spec = previous[pane];
      if (!value) return previous;
      const next = change(value);
      return next === value ? previous : { ...previous, [pane]: {
        ...spec, tabs: spec.tabs.map((item, index) => spec.activeTab === index ? next : item),
      } };
    });
  }
  function navigate(pane: Side, path: ResourcePath) {
    setCursor((previous) => ({ ...previous, [pane]: undefined }));
    patch(pane, (item) => ({ ...item, path, selection: [], filter: "", scrollTop: 0 }));
  }
  function goUp(pane: Side) {
    const value = tabs[pane];
    const above = value && parent(value.path);
    if (above) navigate(pane, above);
  }
  function point(pane: Side, entry: Entry | null, mark = false) {
    const key = entry ? keyOf(entry.name) : upKey;
    setCursor((previous) => ({ ...previous, [pane]: {
      key, index: Math.max(0, entry ? all[pane].indexOf(entry) : 0), explicit: true,
    } }));
    if (entry && mark) patch(pane, (item) => ({
      ...item, selection: item.selection.some((name) => keyOf(name) === key)
        ? item.selection.filter((name) => keyOf(name) !== key) : [...item.selection, entry.name].slice(0, 10_000),
    }));
  }
  function openEntry(pane: Side, entry: Entry | null) {
    const value = tabs[pane];
    if (!value) return;
    if (entry === null) goUp(pane);
    else if (entry.kind === "dir") {
      try { navigate(pane, join(value.path, entry.name)); } catch (error) { setProblem(problemOf(error)); }
    } else view(value, entry);
  }
  function view(value: Tab, entry: Entry) {
    const ref = { endpoint: value.endpoint, path: join(value.path, entry.name) };
    // A local file with a host path opens in BB's own preview when it succeeds; the DOM guarantees of
    // the Commander viewer do not cover that preview. Anything else, such as SFTP, falls back to
    // the Commander viewer, which reads the window through file_read.
    try { props.onPreview(ref); return; } catch { /* No native preview for this entry. */ }
    open({ kind: "view", ref, title: "t" in entry.name ? entry.name.t : "", mode: "auto", result: null, problem: null });
    void loadView(ref, "auto");
  }
  async function loadView(ref: ResourceRef, mode: ViewKind | "auto") {
    try {
      const result = await props.onView(ref, mode);
      setDialog((current) => current?.kind === "view" && current.ref === ref ? { ...current, result, problem: null } : current);
    } catch (error) {
      const failure = problemOf(error);
      // A file that changed while it was viewed; the owner RPC reports it under this internal code.
      const problem = failure.code === "changed_since_plan" ? { code: failure.code, message: ru.view.changed } : failure;
      setDialog((current) => current?.kind === "view" && current.ref === ref ? { ...current, result: null, problem } : current);
    }
  }
  function preview(value: Tab, entry: Entry) {
    try { props.onPreview({ endpoint: value.endpoint, path: join(value.path, entry.name) }); }
    catch (error) { setProblem(problemOf(error)); }
  }
  // S12: the selected entries of the pane, renamed as one batch by a pattern.
  function openBatchRename(value: Tab) {
    const chosen = entries.filter((entry) => selectedNames.some((name) => keyOf(name) === keyOf(entry.name)));
    open({
      kind: "batch-rename", entries: chosen, caseSensitive: endpoint?.caseSensitive ?? true,
      sources: chosen.map((entry) => ({ endpoint: value.endpoint, path: join(value.path, entry.name) })),
    });
  }
  function createBatchRename(sources: ResourceRef[], pattern: RenamePattern) {
    void perform(async () => {
      const plan = await props.onCreate({
        kind: "rename", sources, targetDir: null, newName: null, conflictPolicy: "ask", verify: "size", pattern,
      });
      open({ kind: "plan", plan });
    });
  }
  function create(kind: PlanRequest["kind"], name: string | null = null) {
    if (!tab) return;
    const result = name === null ? null : NameSegment.safeParse({ t: name });
    if (result && !result.success) { setProblem({ code: "invalid_name", message: ru.invalidName }); return; }
    const multi = selectedNames.length ? selectedNames : current ? [current.name] : [];
    const names = kind === "mkdir" ? [] : kind === "rename" ? current ? [current.name] : [] : multi;
    void perform(async () => {
      const plan = await props.onCreate({
        kind, sources: names.map((segment) => ({ endpoint: tab.endpoint, path: join(tab.path, segment) })),
        targetDir: kind === "mkdir" ? currentRef(tab) :
          (kind === "move" || kind === "copy") && destination ? currentRef(destination) : null,
        newName: result?.data ?? null, conflictPolicy: "ask", verify: "size",
      });
      open({ kind: "plan", plan });
    });
  }
  function applyMask(action: "mark" | "unmark" | "invert", mask: string) {
    const matches = maskMatcher(mask);
    patch(side, (value) => {
      const keys = new Map(value.selection.map((name) => [keyOf(name), name]));
      for (const entry of entries) if (matches(entry)) {
        const key = keyOf(entry.name);
        if (action === "unmark" || action === "invert" && keys.has(key)) keys.delete(key);
        else keys.set(key, entry.name);
      }
      return { ...value, selection: [...keys.values()].slice(0, 10_000) };
    });
    close();
  }
  function invoke(action: Shortcut) {
    if (action === "switchPane") {
      setPane(opposite);
      const next = grids[opposite].current;
      if (next?.getClientRects().length || typeof ResizeObserver === "undefined") next?.focus({ preventScroll: true });
      else requestAnimationFrame(() => next?.focus({ preventScroll: true }));
    } else if (action === "up") goUp(side);
    else if (action === "toggle") { if (itemAtCursor) point(side, itemAtCursor, true); }
    else if (action === "invert") applyMask(action, "*");
    else if (action === "mark" || action === "unmark") open({ kind: "text", title: shortcutText[action], label: ru.mask, initial: "*", submit: (value) => applyMask(action, value) });
    else if (can[action] && tab) {
      if (action === "preview") { if (current) view(tab, current); }
      else if (action === "edit") { if (current) preview(tab, current); }
      else if (action === "rename" && selectedNames.length > 1) openBatchRename(tab);
      else if (action === "mkdir" || action === "rename") open({
        kind: "text", title: shortcutText[action], label: ru.fileName,
        initial: action === "rename" && current && "t" in current.name ? current.name.t : "",
        submit: (value) => create(action, value),
      });
      else create(action === "remove" ? "delete" : action);
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const targetElement = event.target as HTMLElement;
    if (event.defaultPrevented) return;
    if (dialog) {
      if (!targetElement.closest(".cm-dialog") || busy) return;
      const key = targetElement.dataset.shortcut as Shortcut | undefined;
      if (dialog.kind === "settings" && key && Object.hasOwn(shortcuts, key)) {
        if (["Tab", "Escape", "Shift", "Meta", "Alt", "Control"].includes(event.key)) return;
        event.preventDefault();
        const value = chord(event), next = { ...bindings };
        for (const action of Object.keys(next) as Shortcut[]) if (next[action] === value) delete next[action];
        props.onBindings({ ...next, [key]: value });
      }
      if (dialog.kind === "conflict" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        const action = event.key.toLowerCase() === "s" ? "skip" : event.key.toLowerCase() === "r" ? "rename" : null;
        const conflict = dialog.job.pendingConflict;
        if (action && conflict && (conflict.allowedResolutions?.includes(action) ?? true)) {
          event.preventDefault();
          decide(dialog.job, action, same);
        }
      }
      return;
    }
    if (!event.currentTarget.contains(targetElement)
      || targetElement.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])")) return;
    const inGrid = !!targetElement.closest(".cm-grid") && !targetElement.closest("button");
    const action = findShortcut(event, bindings);
    if (action && (action !== "switchPane" || inGrid) && (!event.repeat || action === "up")) {
      if (!inGrid && (action === "toggle" || action === "up" || action === "mark" || action === "unmark" || action === "invert")) return;
      event.preventDefault();
      invoke(action);
      return;
    }
    if (!inGrid || event.ctrlKey || event.metaKey || event.altKey || !tab) return;
    const above = parent(tab.path);
    if (event.key === "Enter") {
      if (itemAtCursor || cursor[side]?.key === upKey) { event.preventDefault(); openEntry(side, itemAtCursor ?? null); }
      return;
    }
    const offset = Number(!!above), count = entries.length + offset;
    if (!count) return;
    const currentIndex = cursor[side]?.key === upKey && above ? 0 : itemAtCursor ? entries.indexOf(itemAtCursor) + offset : -1;
    const node = grids[side].current;
    const step = Math.max(1, Math.floor((node?.clientHeight ?? 0) / rowHeight) - 1);
    const destinations: Record<string, number> = {
      ArrowDown: currentIndex + 1, ArrowUp: currentIndex - 1, Home: 0, End: count - 1,
      PageDown: currentIndex + step, PageUp: currentIndex - step,
    };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    const index = Math.min(count - 1, Math.max(0, destinations[event.key]));
    point(side, entries[index - offset] ?? null, event.shiftKey);
    revealCursor(side, index);
  }
  function revealCursor(pane: Side, index: number) {
    const node = grids[pane].current;
    if (!node) return;
    const firstPixel = index * rowHeight, lastPixel = (index + 2) * rowHeight;
    const height = node.clientHeight || 560;
    if (firstPixel < node.scrollTop || lastPixel > node.scrollTop + height) {
      node.scrollTop = firstPixel < node.scrollTop ? firstPixel : Math.max(0, lastPixel - height);
      patch(pane, (value) => ({ ...value, scrollTop: node.scrollTop }));
      if (!node.clientHeight) node.dispatchEvent(new Event("scroll"));
    }
  }
  function tabAction(pane: Side, kind: "select" | "add" | "close", index?: number) {
    setCursor((previous) => ({ ...previous, [pane]: undefined }));
    update((previous) => {
      const spec = previous[pane], currentTab = activeTab(previous, pane);
      if (!currentTab || spec.activeTab === null) return previous;
      const values = spec.tabs.slice();
      let next = index ?? spec.activeTab;
      if (kind === "add" && values.length < 32) { values.push({ ...currentTab, selection: [], scrollTop: 0 }); next = values.length - 1; }
      if (kind === "close" && values.length > 1) { values.splice(next, 1); next = Math.min(values.length - 1, next); }
      return { ...previous, activePane: pane, [pane]: { activeTab: next, tabs: values } };
    });
  }
  function inspect(job: OperationJob) {
    if (job.awaitsOwner) open({ kind: "plan", plan: job.plan, job });
    else if (job.pendingConflict) open({ kind: "conflict", job });
  }
  const info = selectionInfo(directories.left?.entries ?? [], left?.selection ?? []);
  const targetLabel = right ? (endpointsBySide.right?.label ?? right.endpoint) + ":" : "";
  const selection = { ...info, destination: right ? targetLabel + shortPath(right.path) : "—",
    fullDestination: right ? targetLabel + displayPath(right.path) : "—" };
  const queue = <Queue {...props.queue} endpoints={endpoints} id={queueId} open={queueOpen} collapse={queueOpen ? toggleQueue : undefined} compact={compact} selection={selection}
    onInspect={inspect} onSkip={(job) => decide(job, "skip", false)}
    onCancel={(job) => open({ kind: "cancel", job })}
    onRetry={(job) => { void props.onRetry(job).catch((error: unknown) => setProblem(problemOf(error))); }}
    retryNotes={props.retryNotes} />;

  return <div ref={root} className="cm-workspace" data-compact={compact} onKeyDown={onKeyDown}>
    {dialog?.kind === "scan" ? <CompareView subject={dialog.subject} api={props.scans} saved={savedScan(state, dialog.subject)}
      pending={props.startingScans.has(dialog.subject.kind)} close={() => {
        focusScanPanel.current = true;
        close();
      }} /> : <>
    <header className="cm-heading">
      {compact && <h1><Icon name="Folder" />Commander</h1>}
      {!dialog && retryConflict ? <div className="cm-retry">
        <ProblemLine problem={retryConflict.problem} truncate />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => goBack(retryConflict.view)}>{ru.retryConflict}</Button>
      </div> : <><span className="cm-hint">{compact ? ru.threadEnvironment : ru.shortcut}</span><span className="cm-fill" /></>}
      {!compact && <><Button size="sm" variant="outline" aria-label={ru.swap} onClick={() => { setCursor({}); update((previous) => ({ ...previous, left: previous.right, right: previous.left })); }}>
        <Icon name="ArrowUpDown" /><span>{ru.swap}</span></Button>
        <Button size="sm" variant="outline" aria-label={ru.compare} disabled={!left || !right}
          onClick={() => {
            if (!left || !right) return;
            const a = currentRef(left), b = currentRef(right);
            open({ kind: "scan", subject: { kind: "dirs",
              left: { ref: a, label: endpointsBySide.left?.label ?? a.endpoint, readOnly: endpointsBySide.left?.readOnly },
              right: { ref: b, label: endpointsBySide.right?.label ?? b.endpoint, readOnly: endpointsBySide.right?.readOnly },
            } });
          }}>
          <Icon name="FileDiff" /><span>{ru.compare}</span></Button></>}
      <Button size="sm" variant="outline" aria-label={ru.scanChecksum} disabled={!ready || current?.kind !== "file"} onClick={() => {
        if (!tab || current?.kind !== "file") return;
        open({ kind: "scan", subject: { kind: "checksum", file: {
          ref: { endpoint: tab.endpoint, path: join(tab.path, current.name) }, label: endpoint?.label ?? tab.endpoint, readOnly: endpoint?.readOnly,
        } } });
      }}><Icon name="Hash" /><span>SHA-256</span></Button>
      <Button ref={queueToggle} size="sm" variant="ghost" className="cm-queue-toggle" aria-label={ru.queue} aria-expanded={queueOpen}
        aria-controls={queueId} data-queue-open={queueOpen} onClick={toggleQueue}>
        <Icon name="ListTodo" /><span className="cm-count">{props.queue.jobs.length}</span></Button>
      <Button size="sm" variant="ghost" aria-label={ru.keySettings} onClick={() => open({ kind: "settings" })}><Icon name="Keyboard" /></Button>
      {compact && <Button size="sm" variant="ghost" aria-label={ru.fullPage} onClick={props.onOpenPage}><Icon name="PanelRight" /></Button>}
    </header>
    <div className="cm-switch" role="group" aria-label={ru.shortcut}>{sides.map((pane) =>
      <Button key={pane} size="sm" variant="outline" aria-pressed={pane === side} onClick={() => setPane(pane)}>
        <Icon name={endpointsBySide[pane]?.provider === "sftp" ? "ComputerCloud" : "Laptop"} />
        <span>{tabs.left?.endpoint === tabs.right?.endpoint && tabs[pane]?.path.segments.length
          ? nameOf(tabs[pane]!.path.segments.at(-1)!) : endpointsBySide[pane]?.label ?? ru[pane]}</span>
      </Button>)}</div>
    {(props.problem || problem && !dialog) && <ProblemLine problem={(problem ?? props.problem)!} />}
    {notice && <div className="cm-empty" role="status">{notice}</div>}
    <div className="cm-work" data-queue={queueOpen}>
      {sides.map((pane) => {
        const value = tabs[pane], source = endpointsBySide[pane];
        return <Pane key={pane} side={pane} active={pane === side} tab={value} tabs={state[pane].tabs} activeIndex={state[pane].activeTab}
          endpoints={endpoints} endpoint={source} directory={directories[pane]} entries={all[pane]}
          cursor={cursor[pane]?.key ?? null}
          grid={grids[pane]} onFocus={() => setPane(pane)} onTab={(index) => tabAction(pane, "select", index)}
          onAddTab={() => tabAction(pane, "add")} onCloseTab={() => tabAction(pane, "close")}
          onEndpoint={(id) => void perform(() => props.onEndpoint(pane, id), () => setCursor((previous) => ({ ...previous, [pane]: undefined })))}
          onPath={(path) => { try { navigate(pane, parsePosix(path)); setProblem(null); } catch (error) { setProblem(problemOf(error)); } }}
          onNavigate={(path) => navigate(pane, path)}
          onFilter={(filter) => patch(pane, (item) => ({ ...item, filter, scrollTop: 0 }))}
          onSort={(by) => patch(pane, (item) => ({ ...item, sort: { by, direction: item.sort.by === by && item.sort.direction === "asc" ? "desc" : "asc" } }))}
          onScroll={(scrollTop) => patch(pane, (item) => item.scrollTop === scrollTop ? item : { ...item, scrollTop })}
          onPoint={(entry, mark) => point(pane, entry, mark)}
          onOpen={(entry) => openEntry(pane, entry)} onRefresh={() => props.onRefresh(pane)}
          onAccess={() => { if (source) void perform(() => props.onAccess(source)); }} />;
      })}
      {queue}
    </div>
    <footer ref={toolbar} className="cm-toolbar">
      {actions.filter(({ key }) => !compact || key === "copy" || key === "preview").map(({ key, icon }) => {
        const shortcut = bindings[key] ?? shortcuts[key][0];
        const label = compact && key === "copy" ? ru.compactCopy : shortcutText[key];
        const title = label + " (" + shortcut + ")";
        return <Button asChild key={key} size="sm" variant="outline">
          <button type="button" title={title} aria-label={title} aria-keyshortcuts={shortcut} disabled={busy || !can[key]} onClick={() => invoke(key)}>
            <Icon name={icon} /><span>{label}</span>
            <kbd aria-hidden="true">{shortcut}</kbd>
          </button>
        </Button>;
      })}
      <span className="cm-fill" />
      {endpoint?.provider === "local" && <Button size="sm" variant="outline" aria-label={compact ? ru.compactTerminal : ru.terminal} className="cm-terminal" disabled={!can.terminal || busy}
        onClick={() => { if (tab) void perform(() => props.onTerminal(currentRef(tab))); }}>
        <Icon name="Terminal" /><span>{compact ? ru.compactTerminal : ru.terminal}</span></Button>}
    </footer>
    {dialog?.kind === "text" && <TextDialog {...dialog} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "batch-rename" && <BatchRenameDialog entries={dialog.entries} directory={entries}
      caseSensitive={dialog.caseSensitive} busy={busy} error={problem}
      submit={(pattern) => createBatchRename(dialog.sources, pattern)} close={close} />}
    {dialog?.kind === "plan" && <PlanDialog plan={dialog.plan} job={dialog.job} endpoints={endpoints}
      inspect={props.onInspect} run={() => void perform(() => dialog.job ? props.onApprove(dialog.job) : props.onRun(dialog.plan), close)}
      reject={() => { if (dialog.job) void perform(() => props.onReject(dialog.job!), close); }}
      openThread={props.onOpenThread} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "conflict" && <ConflictDialog key={dialog.job.pendingConflict?.id} job={dialog.job} endpoints={endpoints} same={same} onSame={setSame}
      decide={(action, same) => decide(dialog.job, action, same)}
      compare={(source, targetRef) => void perform(async () => {
        const [leftText, rightText] = await props.onCompare(source, targetRef);
        open({ kind: "content", source: leftText, target: rightText, returnTo: dialog });
      })}
      cancel={() => open({ kind: "cancel", job: dialog.job, returnTo: dialog })} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "cancel" && <Modal title={ru.cancelJob} description={ru.cancelConfirm} close={dialog.returnTo ? () => goBack(dialog.returnTo!) : close} busy={busy}>
      {problem && <ProblemLine problem={problem} />}
      <div className="cm-actions">
        <Button size="sm" variant="outline" onClick={dialog.returnTo ? () => goBack(dialog.returnTo!) : close} disabled={busy}>{ru.close}</Button>
        <Button size="sm" variant="destructive" disabled={busy || !activeJob} onClick={() => void perform(() => props.onCancel(dialog.job), close)}>{ru.cancelJob}</Button>
      </div>
    </Modal>}
    {dialog?.kind === "content" && <Modal title={ru.content} description={dialog.source === dialog.target ? ru.compareEqual : ru.compareChanged} close={() => goBack(dialog.returnTo)} busy={busy}>
      {problem && <ProblemLine problem={problem} />}
      <div className="cm-pair">
        <div className="cm-detail"><strong>{ru.source}</strong><pre>{dialog.source}</pre></div>
        <div className="cm-detail"><strong>{ru.existing}</strong><pre>{dialog.target}</pre></div>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => goBack(dialog.returnTo)}>{ru.close}</Button>
    </Modal>}
    {dialog?.kind === "view" && <Modal title={dialog.title} close={close}>
      {dialog.result && <Viewer name={dialog.title} model={dialog.result.model} modes={dialog.result.modes}
        onMode={(mode) => { setDialog({ ...dialog, mode, result: null, problem: null }); void loadView(dialog.ref, mode); }} />}
      {dialog.problem && <ProblemLine problem={dialog.problem} />}
      <div className="cm-actions">
        {dialog.problem && <Button size="sm" variant="outline" onClick={() => { setDialog({ ...dialog, result: null, problem: null }); void loadView(dialog.ref, dialog.mode); }}>{ru.refresh}</Button>}
        <Button size="sm" variant="outline" onClick={close}>{ru.close}</Button>
      </div>
    </Modal>}
    {dialog?.kind === "settings" && <Modal title={ru.keySettings} description={ru.keyHint} close={close}>
      <div className="cm-keymap">{(Object.keys(shortcuts) as Shortcut[]).map((key) => <label key={key}>
        {shortcutText[key]}<input readOnly value={bindings[key] ?? shortcuts[key].join(" / ")}
          data-shortcut={key} /></label>)}</div>
      <div className="cm-actions"><Button size="sm" variant="outline" onClick={() => props.onBindings({})}>{ru.resetKeys}</Button>
        <Button size="sm" onClick={close}>{ru.close}</Button></div>
    </Modal>}
    </>}
  </div>;
}
