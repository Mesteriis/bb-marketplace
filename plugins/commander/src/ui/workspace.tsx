import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { ConflictAction, Entry, OperationJob, OperationPlan, ResourceRef } from "../core/model.ts";
import { displayPath, join, NameSegment, parent, parsePosix, type ResourcePath } from "../core/path.ts";
import type { AgentGrant, UiState } from "../core/wire/rpc.ts";
import { ConflictDialog, Modal, PlanDialog, TextDialog } from "./dialogs.tsx";
import { chord, findShortcut, shortcuts, shortcutText, type KeyBindings, type Shortcut } from "./keyboard.ts";
import { activeTab, currentRef, keyOf, nameOf, nativePath, otherSide, problemOf, selectionInfo, sides, visibleEntries,
  type Directory, type EndpointView, type PlanCheck, type PlanRequest, type Problem, type Side, type Tab } from "./model.ts";
import { Pane, ProblemLine, rowHeight, upKey } from "./pane.tsx";
import { Queue, type QueueProps } from "./queue.tsx";
import { ru } from "./strings.ts";

type DialogState = { kind: "plan"; plan: OperationPlan; job?: OperationJob }
  | { kind: "conflict" | "cancel"; job: OperationJob }
  | { kind: "text"; title: string; label: string; initial?: string; submit: (value: string) => void }
  | { kind: "compare"; difference: [number, number, number, number] }
  | { kind: "content"; source: string; target: string }
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
  onDecide: (job: OperationJob, action: ConflictAction, same: boolean) => Promise<unknown>;
  onCancel: (job: OperationJob) => Promise<unknown>;
  onPreview: (ref: ResourceRef) => void;
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

function compareEntries(left: Entry[], right: Entry[]): [number, number, number, number] {
  const byName = new Map(right.map((entry) => [keyOf(entry.name), entry]));
  let onlyLeft = 0, changed = 0, equal = 0;
  for (const entry of left) {
    const key = keyOf(entry.name), counterpart = byName.get(key);
    if (!counterpart) onlyLeft++;
    else if (entry.kind === counterpart.kind && entry.size === counterpart.size && entry.mtimeNs === counterpart.mtimeNs) equal++;
    else changed++;
    byName.delete(key);
  }
  return [onlyLeft, byName.size, changed, equal];
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

export function Workspace(props: WorkspaceProps) {
  const { state, update, endpoints, directories, compact, bindings } = props;
  const [queueOpen, setQueueOpen] = useState(false);
  const [cursor, setCursor] = useState<Partial<Record<Side, string>>>({});
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [same, setSame] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const focusReturn = useRef<HTMLElement | null>(null);
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
  const current = entries.find((entry) => keyOf(entry.name) === cursor[side]) ?? (cursor[side] === upKey ? undefined : entries[0]);
  const targetReady = !!target && !target.readOnly && !directories[opposite]?.loading && !directories[opposite]?.error;
  const ready = !!endpoint && !directories[side]?.error && !directories[side]?.loading;
  const selected = !!tab?.selection.length || !!current;
  const can: Record<string, boolean> = {
    preview: ready && endpoint?.provider === "local" && !!endpoint.hostId && current?.kind !== "dir" && !!current &&
      "t" in current.name && !!tab && nativePath(tab.path) !== null,
    copy: ready && targetReady && selected, move: ready && targetReady && selected && !endpoint?.readOnly,
    mkdir: ready && !endpoint?.readOnly, remove: ready && selected && !endpoint?.readOnly,
    rename: ready && !!current && !endpoint?.readOnly,
    terminal: !!ready && endpoint?.provider === "local" && !!endpoint.hostId && !!tab && nativePath(tab.path) !== null,
  };
  can.edit = can.preview;
  const activeJob = dialog && "job" in dialog && dialog.job
    ? props.queue.jobs.find((job): job is OperationJob => job.id === dialog.job?.id && "plan" in job) : null;
  useLayoutEffect(() => {
    if (dialog || !focusReturn.current) return;
    const previous = focusReturn.current;
    focusReturn.current = null;
    queueMicrotask(() => { if (previous.isConnected) previous.focus({ preventScroll: true }); });
  }, [dialog]);
  const close = () => { setDialog(null); setProblem(null); };
  const open = (next: DialogState) => {
    if (!dialog) focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProblem(null);
    if (next.kind === "conflict") setSame(false);
    setDialog(next);
  };
  async function perform(action: () => Promise<unknown>, completed?: () => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
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
    setCursor((previous) => ({ ...previous, [pane]: key }));
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
    } else preview(value, entry);
  }
  function preview(value: Tab, entry: Entry) {
    try { props.onPreview({ endpoint: value.endpoint, path: join(value.path, entry.name) }); }
    catch (error) { setProblem(problemOf(error)); }
  }
  function create(kind: PlanRequest["kind"], name: string | null = null) {
    if (!tab) return;
    const result = name === null ? null : NameSegment.safeParse({ t: name });
    if (result && !result.success) { setProblem({ code: "invalid_name", message: ru.invalidName }); return; }
    const multi = tab.selection.length ? tab.selection : current ? [current.name] : [];
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
    else if (action === "toggle") { if (current) point(side, current, true); }
    else if (action === "invert") applyMask(action, "*");
    else if (action === "mark" || action === "unmark") open({ kind: "text", title: shortcutText[action], label: ru.mask, initial: "*", submit: (value) => applyMask(action, value) });
    else if (can[action] && tab) {
      if (action === "preview" || action === "edit") { if (current) preview(tab, current); }
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
          void perform(() => props.onDecide(dialog.job, action, same), close);
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
      if (current || cursor[side] === upKey) { event.preventDefault(); openEntry(side, current ?? null); }
      return;
    }
    const offset = Number(!!above), count = entries.length + offset;
    if (!count) return;
    const currentIndex = cursor[side] === upKey && above ? 0 : current ? entries.indexOf(current) + offset : 0;
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
    if (node) {
      const firstPixel = index * rowHeight, lastPixel = (index + 2) * rowHeight;
      if (firstPixel < node.scrollTop || lastPixel > node.scrollTop + node.clientHeight) {
        node.scrollTop = firstPixel < node.scrollTop ? firstPixel : Math.max(0, lastPixel - (node.clientHeight || 560));
        patch(side, (value) => ({ ...value, scrollTop: node.scrollTop }));
        if (!node.clientHeight) node.dispatchEvent(new Event("scroll"));
      }
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
  const selection = { ...info, destination: right ? (endpointsBySide.right?.label ?? right.endpoint) + ":" + displayPath(right.path) : "—" };
  const queue = <Queue {...props.queue} endpoints={endpoints} open={queueOpen} compact={compact} selection={selection}
    onInspect={inspect} onSkip={(job) => void perform(() => props.onDecide(job, "skip", false))}
    onCancel={(job) => open({ kind: "cancel", job })} />;

  return <div className="cm-workspace" data-compact={compact} onKeyDown={onKeyDown}>
    <header className="cm-heading">
      <h1>{compact && <Icon name="Folder" />}Commander</h1>
      <span className="cm-hint">{compact ? ru.threadEnvironment : ru.shortcut}</span><span className="cm-fill" />
      {!compact && <><Button size="sm" variant="outline" onClick={() => { setCursor({}); update((previous) => ({ ...previous, left: previous.right, right: previous.left })); }}>
        <Icon name="ArrowUpDown" /><span>{ru.swap}</span></Button>
        <Button size="sm" variant="outline" disabled={!ready || !destination || !directories.left || !directories.right ||
          directories.left.loading || directories.right.loading || !!directories.left.error || !!directories.right.error}
          onClick={() => open({ kind: "compare", difference: compareEntries(directories.left!.entries, directories.right!.entries) })}>
          <Icon name="FileDiff" /><span>{ru.compare}</span></Button></>}
      <Button size="sm" variant="ghost" className="cm-queue-toggle" aria-label={ru.queue} aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}>
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
    <div className="cm-work" data-queue={queueOpen}>
      {sides.map((pane) => {
        const value = tabs[pane], source = endpointsBySide[pane];
        return <Pane key={pane} side={pane} active={pane === side} tab={value} tabs={state[pane].tabs} activeIndex={state[pane].activeTab}
          endpoints={endpoints} endpoint={source} directory={directories[pane]} entries={all[pane]}
          cursor={cursor[pane] ?? (all[pane][0] ? keyOf(all[pane][0].name) : null)}
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
    <footer className="cm-toolbar">
      {actions.filter(({ key }) => !compact || key === "copy" || key === "preview").map(({ key, icon }) =>
        <Button key={key} aria-keyshortcuts={bindings[key] ?? shortcuts[key][0]} size="sm" variant="outline" disabled={busy || !can[key]}
          onClick={() => invoke(key)}><Icon name={icon} /><span>{compact && key === "copy" ? ru.compactCopy : shortcutText[key]}</span>
          {!compact && <kbd>{bindings[key] ?? shortcuts[key][0]}</kbd>}</Button>)}
      <span className="cm-fill" />
      {endpoint?.provider === "local" && <Button size="sm" variant="outline" disabled={!can.terminal || busy}
        onClick={() => { if (tab) void perform(() => props.onTerminal(currentRef(tab))); }}>
        <Icon name="Terminal" /><span>{compact ? ru.compactTerminal : ru.terminal}</span></Button>}
    </footer>
    {dialog?.kind === "text" && <TextDialog {...dialog} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "plan" && <PlanDialog plan={dialog.plan} job={dialog.job} endpoints={endpoints}
      inspect={props.onInspect} run={() => void perform(() => dialog.job ? props.onApprove(dialog.job) : props.onRun(dialog.plan), close)}
      reject={() => { if (dialog.job) void perform(() => props.onReject(dialog.job!), close); }}
      openThread={props.onOpenThread} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "conflict" && <ConflictDialog key={dialog.job.pendingConflict?.id} job={dialog.job} endpoints={endpoints} same={same} onSame={setSame}
      decide={(action, same) => void perform(() => props.onDecide(dialog.job, action, same), close)}
      compare={(source, targetRef) => void perform(async () => {
        const [leftText, rightText] = await props.onCompare(source, targetRef);
        open({ kind: "content", source: leftText, target: rightText });
      })}
      cancel={() => open({ kind: "cancel", job: dialog.job })} close={close} busy={busy} error={problem} />}
    {dialog?.kind === "cancel" && <Modal title={ru.cancelJob} description={ru.cancelConfirm} close={close} busy={busy}>
      {problem && <ProblemLine problem={problem} />}
      <div className="cm-actions">
        <Button size="sm" variant="outline" onClick={close} disabled={busy}>{ru.close}</Button>
        <Button size="sm" variant="destructive" disabled={busy || !activeJob} onClick={() => void perform(() => props.onCancel(dialog.job), close)}>{ru.cancelJob}</Button>
      </div>
    </Modal>}
    {dialog?.kind === "compare" && <Modal title={ru.compare} close={close}>
      <dl className="cm-facts">{[ru.compareOnlyLeft, ru.compareOnlyRight, ru.compareChanged, ru.compareEqual].map((label, index) =>
        <div key={label}><dt>{label}</dt><dd>{dialog.difference[index]}</dd></div>)}</dl>
      <Button size="sm" variant="outline" onClick={close}>{ru.close}</Button>
    </Modal>}
    {dialog?.kind === "content" && <Modal title={ru.content} description={dialog.source === dialog.target ? ru.compareEqual : ru.compareChanged} close={close}>
      <div className="cm-pair">
        <div className="cm-detail"><strong>{ru.source}</strong><pre>{dialog.source}</pre></div>
        <div className="cm-detail"><strong>{ru.existing}</strong><pre>{dialog.target}</pre></div>
      </div>
      <Button size="sm" variant="outline" onClick={close}>{ru.close}</Button>
    </Modal>}
    {dialog?.kind === "settings" && <Modal title={ru.keySettings} description={ru.keyHint} close={close}>
      <div className="cm-keymap">{(Object.keys(shortcuts) as Shortcut[]).map((key) => <label key={key}>
        {shortcutText[key]}<input readOnly value={bindings[key] ?? shortcuts[key].join(" / ")}
          data-shortcut={key} /></label>)}</div>
      <div className="cm-actions"><Button size="sm" variant="outline" onClick={() => props.onBindings({})}>{ru.resetKeys}</Button>
        <Button size="sm" onClick={close}>{ru.close}</Button></div>
    </Modal>}
  </div>;
}
