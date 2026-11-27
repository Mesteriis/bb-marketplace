import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { Entry } from "../core/model.ts";
import { displayPath, parent, type ResourcePath } from "../core/path.ts";
import { bytes, date, shortDate, keyOf, nameOf, nativePath, selectionInfo, type Directory, type EndpointView, type Problem, type Side, type Tab } from "./model.ts";
import { ru } from "./strings.ts";

export const rowHeight = 28;
const overscan = 8;
export const upKey = "parent";
export const entryIcon = { dir: "Folder", file: "File", symlink: "Link", other: "FileQuestion" };

export function ProblemLine({ problem, truncate }: { problem: Problem; truncate?: boolean }) {
  const title = truncate ? [problem.code, problem.message].filter(Boolean).join(" ") : undefined;
  return <div className="cm-problem" role="alert">
    <Icon name="AlertTriangle" aria-hidden="true" />
    <span title={title}><code>{problem.code}</code>{problem.message && " " + problem.message}</span>
  </div>;
}

function Breadcrumbs({ segments }: { segments: ResourcePath["segments"] }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [first, setFirst] = useState(0);
  const names = segments.slice(-32).map(nameOf);
  const labels = [segments.length > names.length ? "…/" : "/", ...names.map((name, index) => name + (index < names.length - 1 ? " /" : ""))];
  useLayoutEffect(() => {
    const node = viewport.current, row = measure.current;
    if (!node || !row || typeof ResizeObserver === "undefined") return;
    const align = () => {
      if (!node.clientWidth) return;
      const parts = Array.from(row.children, (part) => part.getBoundingClientRect().width);
      const width = node.clientWidth;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const ellipsis = parts.pop() ?? 0;
      if (parts.reduce((sum, part) => sum + part, 0) + gap * (parts.length - 1) <= width) { setFirst(0); return; }
      let used = ellipsis;
      let start = parts.length - 1;
      while (start > 0 && used + parts[start] + gap <= width) {
        used += parts[start] + gap;
        start--;
      }
      setFirst(Math.min(start + 1, parts.length - 1));
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(node);
    observer.observe(row);
    return () => observer.disconnect();
  }, [segments]);
  return <span className="cm-crumbs" ref={viewport} aria-hidden="true">
    {first > 0 && <span>…/</span>}
    {labels.slice(first).map((label, index) => <span key={index}>{label}</span>)}
    <span className="cm-crumb-measure" ref={measure}>{[...labels, "…/"].map((label, index) => <span key={index}>{label}</span>)}</span>
  </span>;
}

function Address({ tab, onPath, onFilter, onParent, onRefresh, onSearch }: {
  tab: Tab; onPath: (input: string) => void; onFilter: (value: string) => void;
  onParent: () => void; onRefresh: () => void; onSearch?: () => void;
}) {
  const [path, setPath] = useState(nativePath(tab.path) ?? displayPath(tab.path));
  return <div className="cm-address">
    <Button size="sm" variant="ghost" aria-label={ru.up} disabled={!parent(tab.path)} onClick={onParent}><Icon name="ArrowUp" /></Button>
    <form onSubmit={(event) => { event.preventDefault(); onPath(path); }}>
      <Input aria-label={ru.path} title={displayPath(tab.path)} value={path} onChange={(event) => setPath(event.currentTarget.value)} />
      <Breadcrumbs segments={tab.path.segments} />
    </form>
    <Input type="search" className="cm-filter" aria-label={ru.filter} placeholder={ru.filter} value={tab.filter}
      maxLength={1024} onChange={(event) => onFilter(event.currentTarget.value)} />
    {onSearch && <Button type="button" size="sm" variant="ghost" aria-label={ru.search.title}
      onClick={onSearch}><Icon name="Search" /></Button>}
    <Button size="sm" variant="ghost" aria-label={ru.refresh} onClick={onRefresh}><Icon name="ArrowReloadHorizontal" /></Button>
  </div>;
}

export interface PaneProps {
  side: Side;
  active: boolean;
  tab?: Tab;
  tabs: Tab[];
  activeIndex: number | null;
  endpoints: EndpointView[];
  endpoint?: EndpointView;
  directory?: Directory;
  entries: Entry[];
  cursor: string | null;
  grid: RefObject<HTMLDivElement | null>;
  onFocus: () => void;
  onTab: (index: number) => void;
  onAddTab: () => void;
  onCloseTab: () => void;
  onEndpoint: (id: string) => void;
  onPath: (path: string) => void;
  onNavigate: (path: ResourcePath) => void;
  onFilter: (value: string) => void;
  onSort: (by: Tab["sort"]["by"]) => void;
  onScroll: (scrollTop: number) => void;
  onPoint: (entry: Entry | null, mark: boolean) => void;
  onOpen: (entry: Entry | null) => void;
  onRefresh: () => void;
  onAccess: () => void;
  onSearch?: () => void;
}

export function Pane(props: PaneProps) {
  const { tab, endpoint, directory, entries, cursor, grid } = props;
  const uid = useId();
  const [height, setHeight] = useState(560);
  const [top, setTop] = useState(tab?.scrollTop ?? 0);
  const location = tab ? JSON.stringify([tab.endpoint, tab.path, props.activeIndex]) : "";
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || !tab || directory?.loading) return;
    node.scrollTop = tab.scrollTop;
    setTop(node.scrollTop);
  // A refresh of the same directory must leave its scroll position alone.
  }, [grid, location, directory?.loading]);
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [grid, location]);

  const above = tab ? parent(tab.path) : null;
  const offset = above ? 1 : 0;
  const hasRows = !!endpoint && !directory?.loading && !directory?.error;
  const total = hasRows ? entries.length + offset : 0;
  const status = directory?.loading
    ? <div className="cm-skeleton" role="status" aria-label={ru.loading}>
      {Array.from({ length: 9 }, (_, index) => <div key={index}><span /><span /></div>)}
    </div> : directory?.error ? <ProblemLine problem={directory.error} /> :
    !endpoint ? <div className="cm-empty">{ru.noEndpoint}</div> :
    directory && entries.length === 0 ? <div className="cm-empty">{tab?.filter ? ru.noResults : ru.empty}</div> : null;
  const first = Math.min(total, Math.max(0, Math.floor(top / rowHeight) - overscan));
  const end = Math.min(total, first + Math.min(199, Math.ceil(height / rowHeight) + overscan * 2));
  const selected = new Set(tab?.selection.map(keyOf));
  const info = selectionInfo(directory?.entries ?? [], tab?.selection ?? []);
  const cursorIndex = cursor === upKey && above ? 0 : entries.findIndex((entry) => keyOf(entry.name) === cursor) + offset;
  const renderedCursor = cursor !== null && cursorIndex >= first && cursorIndex < end
    && (cursor === upKey || cursorIndex >= offset);
  const sources = props.endpoints.map((source) => <option key={source.id} value={source.id}>{source.label}</option>);
  const provider = endpoint?.provider === "sftp" ? ru.sftp : ru.local;
  const access = endpoint?.readOnly ? ru.readOnly : ru.writable;
  const sortCells = [
    { by: "name", label: ru.nameSort }, { by: "size", label: ru.sizeSort }, { by: "mtime", label: ru.dateSort },
  ] as const;

  return <section className="cm-pane" data-side={props.side} data-active={props.active} onFocus={props.onFocus}>
    <div className="cm-source">
      <Icon name={endpoint?.provider === "sftp" ? "ComputerCloud" : "Laptop"} />
      <select aria-label={ru[props.side]} title={endpoint?.machine} value={endpoint?.id ?? ""}
        onChange={(event) => props.onEndpoint(event.currentTarget.value)}>
        {!endpoint && <option value="" disabled>{ru.noEndpoint}</option>}
        {sources}
      </select>
      {endpoint && <>
        {endpoint.machine !== endpoint.label && <span className="cm-machine" title={endpoint.machine}>{endpoint.machine}</span>}
        <span className="cm-provider">{provider}</span>
        <span className="cm-source-spacer" />
        <span className="cm-access" title={access} aria-label={access} role="img">
          <Icon name={endpoint.readOnly ? "Lock" : "Edit"} /><span aria-hidden="true">{access}</span>
        </span>
      </>}
      {endpoint?.provider === "sftp" && endpoint.consent !== "granted" &&
        <Button size="sm" variant="outline" aria-label={ru.access} onClick={props.onAccess}><Icon name="Lock" /></Button>}
    </div>
    <div className="cm-tabstrip">
      <div className="cm-tabs">
        {props.tabs.map((item, index) => {
          const name = item.path.segments.at(-1);
          return <Button asChild key={index} size="sm" variant="ghost" aria-pressed={index === props.activeIndex}
            onClick={() => props.onTab(index)}><button title={name ? nameOf(name) : "/"}>{name ? nameOf(name) : "/"}</button></Button>;
        })}
      </div>
      <Button size="sm" variant="ghost" disabled={!tab || props.tabs.length === 32} aria-label={ru.addTab} onClick={props.onAddTab}><Icon name="Plus" /></Button>
      {props.tabs.length > 1 && <Button size="sm" variant="ghost" aria-label={ru.closeTab} onClick={props.onCloseTab}><Icon name="X" /></Button>}
    </div>
    {tab && <Address key={location} tab={tab} onPath={props.onPath} onFilter={props.onFilter}
      onParent={() => { if (above) props.onNavigate(above); }} onRefresh={props.onRefresh} onSearch={props.onSearch} />}
    <div className="cm-grid" ref={grid} role="grid" tabIndex={0} aria-label={ru[props.side]} aria-multiselectable="true"
      aria-busy={!!directory?.loading} aria-rowcount={total + 1 + Number(!!status)}
      aria-activedescendant={renderedCursor ? uid + "-" + cursorIndex : undefined}
      onScroll={(event) => { const value = event.currentTarget.scrollTop; setTop(value); if (!directory?.loading) props.onScroll(value); }}>
      <div className="cm-row cm-columns" role="row" aria-rowindex={1}>
        {sortCells.map(({ by, label }) => <div key={by} role="columnheader"
          aria-sort={tab?.sort.by === by ? tab.sort.direction === "asc" ? "ascending" : "descending" : undefined}>
          <Button size="sm" variant="ghost" onClick={() => props.onSort(by)}>{label}</Button>
        </div>)}
      </div>
      {hasRows && <div role="rowgroup" style={{ position: "relative", height: total * rowHeight }}>
          {Array.from({ length: Math.max(0, end - first) }, (_, delta) => {
            const index = first + delta;
            const entry = entries[index - offset] ?? null;
            const key = entry ? keyOf(entry.name) : upKey;
            const name = entry ? nameOf(entry.name) : "..";
            return <div role="row" aria-rowindex={index + 2} aria-selected={selected.has(key)} id={uid + "-" + index}
              key={key} className="cm-row cm-entry" style={{ top: index * rowHeight }} data-cursor={cursor === key}
              onClick={(event) => { grid.current?.focus({ preventScroll: true }); props.onPoint(entry, event.ctrlKey || event.metaKey || event.shiftKey); }}
              onDoubleClick={() => props.onOpen(entry)}>
              <div role="gridcell" className="cm-name"><Icon name={entry ? entryIcon[entry.kind] : "ArrowTurnBackward"} /><span title={name}>{name}</span></div>
              <div role="gridcell">{entry && entry.kind !== "dir" ? bytes(entry.size) : ""}</div>
              <div role="gridcell" title={entry ? date(entry.mtimeNs, true) : undefined}>{entry ? shortDate(entry.mtimeNs) : ""}</div>
            </div>;
          })}
        </div>}
      {status && <div role="row" aria-rowindex={total + 2}><div role="gridcell" aria-colspan={3}>{status}</div></div>}
    </div>
    <div className="cm-summary">{info.count} {ru.outOf} {directory?.entries.length ?? 0} {ru.selected} · {info.size}</div>
  </section>;
}
