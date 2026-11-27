import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import type { ResourceRef } from "../core/model.ts";
import { displayPath, parent } from "../core/path.ts";
import type { SearchHit } from "../core/search.ts";
import type { RpcInput, ScanEstimateView, ScanGetView } from "../core/wire/rpc.ts";
import { bytes, date, nameOf, problemOf, shortDate, type Problem, type Side } from "./model.ts";
import { entryIcon, ProblemLine, rowHeight } from "./pane.tsx";
import { ru } from "./strings.ts";

type Request = Extract<RpcInput<"scan_start">, { kind: "search" }>;
export interface SearchActions {
  start(input: Request, signal: AbortSignal): Promise<ScanGetView["job"] | ScanEstimateView>;
  get(id: string): Promise<ScanGetView | null>;
  cancel(id: string): Promise<unknown>;
}

interface Props {
  side: Side;
  active: boolean;
  root: ResourceRef;
  label: string;
  savedId?: string;
  grid?: RefObject<HTMLDivElement | null>;
  api: SearchActions;
  onFocus(): void;
  onClose(): void;
  onSave(id: string): void;
  onOpen(hit: SearchHit): void;
  onCopy?(refs: ResourceRef[]): void;
}

const noHits: SearchHit[] = [];

export function SearchPanel({ side, active, root, label, savedId, grid, api, onFocus, onClose, onSave, onOpen, onCopy }: Props) {
  const t = ru.search;
  const remote = root.endpoint.startsWith("sftp:");
  const uid = useId();
  const localGrid = useRef<HTMLDivElement>(null);
  const viewport = grid ?? localGrid;
  const [id, setId] = useState<string | undefined>(savedId);
  const [view, setView] = useState<ScanGetView | null>(null);
  const [estimate, setEstimate] = useState<{ request: Request; reply: ScanEstimateView } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRequest = useRef<AbortController | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [content, setContent] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(560);
  const job = view?.job;
  const failure = job?.error && job.state !== "cancelled"
    ? job.error.message === "Unsafe search regex"
      ? { code: job.error.code, message: t.unsafeRegex }
      : problemOf(job.error)
    : null;
  const result = view?.result && "hits" in view.result ? view.result : null;
  const hits = result?.hits ?? noHits;
  const current = hits[cursor];
  const busy = pending || !!id && (!job || job.state === "running");
  const first = Math.max(0, Math.floor(top / rowHeight) - 8);
  const last = Math.min(hits.length, first + Math.ceil(height / rowHeight) + 16);
  const columns = { gridTemplateColumns: "minmax(68px, 1fr) minmax(45px, 1fr) minmax(62px, 0.45fr) minmax(100px, 0.65fr)" };

  useEffect(() => {
    const node = viewport.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewport]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(scanId: string) {
      try {
        const reply = await api.get(scanId);
        if (!active) return;
        if (!reply || reply.reason === "result_expired") {
          setId(undefined);
          setProblem({ code: "not_found", message: t.expired });
          return;
        }
        setView(reply);
        if (reply.job.state === "running") timer = setTimeout(() => void poll(scanId), 350);
      } catch (error) {
        if (!active) return;
        setProblem(problemOf(error));
        timer = setTimeout(() => void poll(scanId), 1000);
      }
    }
    void poll(id);
    return () => { active = false; clearTimeout(timer); };
  }, [id, api, t.expired]);

  useEffect(() => () => pendingRequest.current?.abort(), []);

  async function start(request: Request, estimateOnly = false) {
    if (pendingRequest.current) return;
    const controller = new AbortController();
    pendingRequest.current = controller;
    setEstimate(null);
    setProblem(null);
    setPending(true);
    try {
      const reply = await api.start(estimateOnly ? { ...request, estimateOnly: true } : request, controller.signal);
      if (controller.signal.aborted) {
        // The response may have arrived as the user cancelled. Cancel its job too.
        if ("id" in reply) await api.cancel(reply.id);
        return;
      }
      if ("estimateId" in reply) setEstimate({ request, reply });
      else {
        setId(reply.id);
        setView({ job: reply, result: null });
        setCursor(0);
        setTop(0);
        setSelected(new Set());
        if (viewport.current) viewport.current.scrollTop = 0;
      }
    } catch (error) {
      if (!controller.signal.aborted) setProblem(problemOf(error));
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (key: string) => String(form.get(key) ?? "") || undefined;
    const name = get("name");
    const after = get("after"), before = get("before");
    const request: Request = {
      kind: "search", root,
      name: name ? form.get("regex") ? { regex: name } : { glob: name } : undefined,
      content: content ? { text: content, caseSensitive: form.has("case") } : undefined,
      minSize: get("min"), maxSize: get("max"),
      modifiedAfter: after && new Date(after + "T00:00:00").toISOString(),
      modifiedBefore: before && new Date(before + "T23:59:59.999").toISOString(),
      limits: { maxDepth: Number(get("depth") ?? 32), maxEntries: Number(get("entries") ?? 100_000),
        maxBytesRead: get("budget") },
    };
    void start(request, remote && !!request.content);
  }

  function abortStart() {
    if (!pendingRequest.current) return false;
    pendingRequest.current.abort();
    pendingRequest.current = null;
    setPending(false);
    return true;
  }

  function close() {
    abortStart();
    if (id && !savedId && job?.state === "running") void api.cancel(id).catch(() => {});
    onClose();
  }

  function cancel() {
    if (abortStart() || !id) return;
    void api.cancel(id).catch((error: unknown) => setProblem(problemOf(error)));
  }

  function copy() {
    const refs = selected.size ? [...selected].map((index) => hits[index].ref) : current ? [current.ref] : [];
    if (refs.length) onCopy?.(refs);
  }

  function mark(index: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(0, Math.min(hits.length - 1, cursor + (event.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      const node = viewport.current;
      if (node && next * rowHeight < node.scrollTop) node.scrollTop = next * rowHeight;
      if (node && (next + 2) * rowHeight > node.scrollTop + node.clientHeight) {
        node.scrollTop = (next + 2) * rowHeight - node.clientHeight;
      }
    } else if (current && [" ", "Enter", "F3", "F5"].includes(event.key)) {
      event.preventDefault();
      if (event.key === " ") mark(cursor);
      else if (event.key === "F5") copy();
      else if (event.key !== "F3" || current.entry.kind === "file") onOpen(current);
    }
  }

  return <section className="cm-pane" data-side={side} data-active={active} data-search-panel
    aria-label={t.title} onFocus={onFocus}>
    <header style={{ display: "grid", gap: 8, padding: "4px 10px 8px", minWidth: 0 }}>
      <div className="cm-heading" style={{ padding: 0, flexWrap: "wrap" }}>
        <Icon name="Search" /><strong>{savedId ? t.virtual : t.title}</strong>
        <span className="cm-fill" />
        <Button type="button" size="sm" variant="ghost" aria-label={t.close} onClick={close}><Icon name="X" /></Button>
      </div>
      <code className="cm-address cm-scan-path" style={{ margin: 0, paddingInline: 8, display: "block", lineHeight: "32px" }} title={displayPath(root.path)}>{label} · {displayPath(root.path)}</code>
      {!savedId && <form onSubmit={submit} onChange={() => setEstimate(null)}>
        <fieldset disabled={busy} style={{ display: "flex", gap: 6, flexWrap: "wrap", border: 0, padding: 0, margin: 0 }}>
          <Input style={{ flex: "1 1 130px", minWidth: 0 }} name="name" autoFocus maxLength={256} aria-label={t.name} placeholder={t.name} />
          <Input style={{ flex: "1 1 130px", minWidth: 0 }} name="content" maxLength={1024}
            aria-label={t.content} placeholder={t.content} value={content} onChange={(event) => setContent(event.target.value)} />
          <Button type="button" size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t.filters}</Button>
          <Button type="submit" size="sm">{remote && content ? t.estimate : t.start}</Button>
          <div hidden={!advanced} style={{ width: "100%" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))", gap: 6 }}>
              <label><input type="checkbox" name="regex" /> {t.regex}</label>
              <label><input type="checkbox" name="case" /> {t.caseSensitive}</label>
              {([["min", t.min], ["max", t.max]] as const).map(([name, label]) =>
                <label key={name}>{label}<Input name={name} inputMode="numeric" pattern="[0-9]{1,20}" /></label>)}
              {([["after", t.after], ["before", t.before]] as const).map(([name, label]) =>
                <label key={name}>{label}<Input name={name} type="date" /></label>)}
              <label>{t.depth}<Input name="depth" type="number" min={1} max={32} placeholder="32" /></label>
              <label>{t.entries}<Input name="entries" type="number" min={1} max={100_000} placeholder="100000" /></label>
            </div>
          </div>
          {!!content && <label style={{ flex: "1 1 100%" }}>{t.budget}
            <Input name="budget" inputMode="numeric" pattern="[1-9][0-9]{0,19}" required={remote}
              placeholder={remote ? undefined : "1073741824"} /></label>}
        </fieldset>
      </form>}
      {estimate && <div className="cm-scan-estimate" role="status">
        <p>{t.remoteRead} {bytes(estimate.reply.bytesPlanned)} · {t.perRun}</p>
        <Button type="button" size="sm" onClick={() => void start({ ...estimate.request, estimateId: estimate.reply.estimateId })}>{t.confirm}</Button>
      </div>}
      {problem && <ProblemLine problem={problem} />}
      {failure && <ProblemLine problem={failure} />}
    </header>
    <div className="cm-grid" ref={viewport} role="grid" aria-label={t.results} aria-rowcount={hits.length + 1}
      aria-multiselectable="true" tabIndex={0} aria-busy={busy} onKeyDown={keyboard}
      aria-activedescendant={current && cursor >= first && cursor < last ? uid + "-" + cursor : undefined}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      <div className="cm-row cm-columns" role="row" style={columns}>
        {[ru.name, t.directory, ru.size, ru.date].map((name) => <div key={name} role="columnheader" style={name === t.directory ? { justifyContent: "flex-start" } : undefined}>{name}</div>)}
      </div>
      <div role="rowgroup" style={{ position: "relative", height: hits.length * rowHeight }}>
        {hits.slice(first, last).map((hit, delta) => {
          const index = first + delta;
          const name = nameOf(hit.entry.name);
          const path = displayPath(parent(hit.ref.path) ?? root.path);
          const relative = hit.ref.path.segments.slice(root.path.segments.length, -1).map(nameOf).join("/") || ".";
          return <div id={uid + "-" + index} key={index} role="row" aria-rowindex={index + 2}
            aria-selected={selected.has(index)} data-cursor={cursor === index} className="cm-row cm-entry"
            style={{ ...columns, top: index * rowHeight }}
            onClick={(event) => {
              viewport.current?.focus({ preventScroll: true });
              setCursor(index);
              if (event.metaKey || event.ctrlKey || event.shiftKey) mark(index);
            }} onDoubleClick={() => onOpen(hit)}>
            <div role="gridcell" className="cm-name"><Icon name={entryIcon[hit.entry.kind]} /><span title={name}>{name}</span></div>
            <div role="gridcell" title={path} style={{ justifyContent: "flex-start", color: "var(--muted-foreground)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{relative}</span>
            </div>
            <div role="gridcell">{hit.entry.kind === "file" ? bytes(hit.entry.size) : "—"}</div>
            <div role="gridcell" title={date(hit.entry.mtimeNs, true)}>{shortDate(hit.entry.mtimeNs)}</div>
          </div>;
        })}
      </div>
      {result && !hits.length && <p className="cm-empty">{ru.noResults}</p>}
    </div>
    <footer style={{ padding: "4px 10px", borderTop: "1px solid var(--border)" }}>
      {busy && <progress aria-label={t.progress} value={job?.progress.bytesPlanned && job.progress.bytesPlanned !== "0"
        ? Number(job.progress.bytes) / Number(job.progress.bytesPlanned) : undefined} />}
      <div className="cm-heading" style={{ padding: 0, flexWrap: "wrap" }}>
        <span className="cm-meta" aria-live="polite">
          {busy ? (pending ? t.preparing : t.progress) : job?.state === "cancelled" ? t.cancelled : job?.state === "interrupted" ? t.interrupted : ""}
          {result && <>{hits.length} {t.found} · </>}
          {job && <>{job.progress.items} {t.visited}</>}
          {job?.partial && <> · <strong>{t.partial}</strong></>}
        </span>
        <span className="cm-fill" />
        {(pending || job?.state === "running") && <Button size="sm" variant="outline" onClick={cancel}>{t.cancel}</Button>}
        {current && <Button size="sm" variant="outline" onClick={() => onOpen(current)}>{current.entry.kind === "dir" ? t.openFolder : t.preview}</Button>}
        {current && onCopy && <Button size="sm" variant="outline" onClick={copy}>{t.copy}{selected.size > 0 && " (" + selected.size + ")"}</Button>}
        {!savedId && id && result && <Button size="sm" variant="outline" onClick={() => onSave(id)}>{t.save}</Button>}
      </div>
      {current?.line && <div className="cm-meta" style={{ overflowWrap: "anywhere" }}><code>{current.line.number}: {current.line.text}</code></div>}
    </footer>
  </section>;
}
