import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { Entry } from "../core/model.ts";
import { displayPath, parent, type ResourcePath } from "../core/path.ts";
import { bytes, date, keyOf, nameOf, nativePath, selectionInfo, type Directory, type EndpointView, type Problem, type Side, type Tab } from "./model.ts";
import { ru } from "./strings.ts";

export const rowHeight = 28;
const overscan = 8;
export const upKey = "parent";
export const entryIcon = { dir: "Folder", file: "File", symlink: "Link", other: "FileQuestion" };

export function ProblemLine({ problem }: { problem: Problem }) {
  return <div className="cm-problem" role="alert"><code>{problem.code}</code> {problem.message}</div>;
}

function Address({ tab, onPath, onFilter, onParent, onRefresh }: {
  tab: Tab; onPath: (input: string) => void; onFilter: (value: string) => void;
  onParent: () => void; onRefresh: () => void;
}) {
  const [path, setPath] = useState(nativePath(tab.path) ?? displayPath(tab.path));
  return <div className="cm-address">
    <Button size="sm" variant="ghost" aria-label={ru.up} disabled={!parent(tab.path)} onClick={onParent}><Icon name="ArrowUp" /></Button>
    <form onSubmit={(event) => { event.preventDefault(); onPath(path); }}>
      <Input aria-label={ru.path} title={displayPath(tab.path)} value={path} onChange={(event) => setPath(event.currentTarget.value)} />
      <span className="cm-crumbs" aria-hidden="true">
        <span>/</span>{tab.path.segments.map((name, index) => <span key={index}>{nameOf(name)}{index < tab.path.segments.length - 1 && " /"}</span>)}
      </span>
    </form>
    <Input type="search" className="cm-filter" aria-label={ru.filter} placeholder={ru.filter} value={tab.filter}
      maxLength={1024} onChange={(event) => onFilter(event.currentTarget.value)} />
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
  const total = entries.length + offset;
  const first = Math.min(total, Math.max(0, Math.floor(top / rowHeight) - overscan));
  const end = Math.min(total, first + Math.min(199, Math.ceil(height / rowHeight) + overscan * 2));
  const selected = new Set(tab?.selection.map(keyOf));
  const info = selectionInfo(directory?.entries ?? [], tab?.selection ?? []);
  const cursorIndex = cursor === upKey && above ? 0 : entries.findIndex((entry) => keyOf(entry.name) === cursor) + offset;
  const renderedCursor = cursor !== null && cursorIndex >= first && cursorIndex < end
    && (cursor === upKey || cursorIndex >= offset);
  const sources = props.endpoints.map((source) => <option key={source.id} value={source.id}>{source.label}</option>);
  const sortCells = [
    { by: "name", label: ru.nameSort }, { by: "size", label: ru.sizeSort }, { by: "mtime", label: ru.dateSort },
  ] as const;

  return <section className="cm-pane" data-side={props.side} data-active={props.active} onFocus={props.onFocus}>
    <div className="cm-source">
      <Icon name={endpoint?.provider === "sftp" ? "ComputerCloud" : "Laptop"} />
      <select aria-label={props.side === "left" ? ru.left : ru.right} value={endpoint?.id ?? ""}
        onChange={(event) => props.onEndpoint(event.currentTarget.value)}>
        {!endpoint && <option value="" disabled>{ru.noEndpoint}</option>}
        {sources}
      </select>
      {endpoint && <span className="cm-source-detail" title={endpoint.machine}>
        {endpoint.machine !== endpoint.label && <>{endpoint.machine} · </>}
        {endpoint.provider === "sftp" ? ru.sftp : ru.local} · {endpoint.readOnly ? ru.readOnly : ru.writable}
      </span>}
      {endpoint?.provider === "sftp" && endpoint.consent !== "granted" && <Button size="sm" variant="outline" onClick={props.onAccess}>{ru.access}</Button>}
      <div className="cm-tabs">
        {props.tabs.map((item, index) => {
          const name = item.path.segments.at(-1);
          return <Button key={index} size="sm" variant="ghost" aria-pressed={index === props.activeIndex}
            onClick={() => props.onTab(index)}>{name ? nameOf(name) : "/"}</Button>;
        })}
      </div>
      <Button size="sm" variant="ghost" disabled={!tab || props.tabs.length === 32} aria-label={ru.addTab} onClick={props.onAddTab}><Icon name="Plus" /></Button>
      {props.tabs.length > 1 && <Button size="sm" variant="ghost" aria-label={ru.closeTab} onClick={props.onCloseTab}><Icon name="X" /></Button>}
    </div>
    {tab && <Address key={location} tab={tab} onPath={props.onPath} onFilter={props.onFilter}
      onParent={() => { if (above) props.onNavigate(above); }} onRefresh={props.onRefresh} />}
    <div className="cm-grid" ref={grid} role="grid" tabIndex={0} aria-label={ru[props.side]} aria-multiselectable="true"
      aria-busy={!!directory?.loading} aria-rowcount={total + 1}
      aria-activedescendant={renderedCursor ? uid + "-" + cursorIndex : undefined}
      onScroll={(event) => { const value = event.currentTarget.scrollTop; setTop(value); if (!directory?.loading) props.onScroll(value); }}>
      <div className="cm-row cm-columns" role="row" aria-rowindex={1}>
        {sortCells.map(({ by, label }) => <div key={by} role="columnheader"
          aria-sort={tab?.sort.by === by ? tab.sort.direction === "asc" ? "ascending" : "descending" : undefined}>
          <Button size="sm" variant="ghost" onClick={() => props.onSort(by)}>{label}</Button>
        </div>)}
      </div>
      {directory?.loading ? <div className="cm-skeleton" role="status" aria-label={ru.loading}>
        {Array.from({ length: 9 }, (_, index) => <div key={index}><span /><span /></div>)}
      </div> : directory?.error ? <ProblemLine problem={directory.error} />
        : <div role="rowgroup" style={{ position: "relative", height: total * rowHeight }}>
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
              <div role="gridcell">{entry ? date(entry.mtimeNs, true) : ""}</div>
            </div>;
          })}
        </div>}
      {directory && !directory.loading && !directory.error && entries.length === 0 &&
        <div className="cm-empty">{tab?.filter ? ru.noResults : ru.empty}</div>}
      {!endpoint && !directory?.loading && <div className="cm-empty">{ru.noEndpoint}</div>}
    </div>
    <div className="cm-summary">{info.count} {ru.outOf} {directory?.entries.length ?? 0} {ru.selected} · {info.size}</div>
  </section>;
}
