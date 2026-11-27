import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { displayPath } from "../core/path.ts";
import type { Entry, ResourceRef } from "../core/model.ts";
import type { RpcInput, ScanGetView } from "../core/wire/rpc.ts";
import { bytes, date, nameOf, problemOf, shortPath, type Problem } from "./model.ts";
import { ProblemLine } from "./pane.tsx";
import { ru, stateText } from "./strings.ts";

type Request = RpcInput<"scan_start">;
type Estimate = { estimateId: string; bytesPlanned: string };
export interface ScanActions {
  start(input: Request): Promise<ScanGetView["job"] | Estimate>;
  get(id: string): Promise<ScanGetView | null>;
  cancel(id: string): Promise<unknown>;
}

type Target = { ref: ResourceRef; label: string };
export type ScanSubject = { kind: "dirs"; left: Target; right: Target } | { kind: "checksum"; file: Target };
type Phase = { state: "idle" | "starting" }
  | { state: "confirm"; estimate: Estimate }
  | { state: "scan"; view: ScanGetView }
  | { state: "unavailable" };

type Difference = Extract<NonNullable<ScanGetView["result"]>, { onlyLeft: Entry[] }>;
const columns = ["left", "right"] as const;

function DirectoryComparison({ subject, diff, controls, hideEqual }: {
  subject: Extract<ScanSubject, { kind: "dirs" }>; diff: Difference | null; controls: ReactNode; hideEqual: boolean;
}) {
  const rows = diff ? [
    ...diff.differ.map(([left, right]) => ({ left, right, mark: "≠", color: "var(--warning, var(--foreground))" })),
    ...diff.onlyLeft.map((left) => ({ left, right: null, mark: "+", color: "var(--success, var(--foreground))" })),
    ...diff.onlyRight.map((right) => ({ left: null, right, mark: "+", color: "var(--primary)" })),
    ...(hideEqual ? [] : diff.equal ?? []).map(([left, right]) => ({
      left, right, mark: "=", color: "var(--muted-foreground)",
    })),
  ].sort((a, b) => nameOf((a.left ?? a.right)!.name).localeCompare(nameOf((b.left ?? b.right)!.name), "ru")) : [];
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "auto minmax(auto, 1fr) auto", minWidth: 0, flex: "1 1 590px", overflow: "auto" }}>
    {columns.map((side) => <section className="cm-pane" key={side} style={{ display: "grid", gridTemplateRows: "subgrid", gridRow: "1 / span 3" }}>
      <header style={{ padding: "12px", display: "grid", gap: 8 }}>
        <strong className="cm-meta">{ru[side]} · {subject[side].label}</strong>
        <code className="cm-address" title={displayPath(subject[side].ref.path)}
          style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayPath(subject[side].ref.path)}</code>
        <div style={{ minHeight: 30 }}>{side === "left" && controls}</div>
      </header>
      <div style={{ minWidth: 0 }}>
        <table aria-label={ru[side]} style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", textAlign: "left", fontSize: 12 }}>
          <thead style={{ color: "var(--muted-foreground)", borderBottom: "1px solid var(--border)" }}>
            <tr><th aria-label={ru.scanDifference} style={{ width: 28 }} /><th>{ru.name}</th>
              <th style={{ width: "20%" }}>{ru.size}</th><th style={{ width: "32%" }}>{ru.date}</th></tr>
          </thead>
          <tbody>{rows.map((row, index) => {
            const entry = row[side];
            return <tr key={index} style={{ height: 28, color: row.mark === "=" ? "var(--muted-foreground)" : undefined }}>
              <td style={{ color: row.color, textAlign: "center" }}>{entry && row.mark}</td>
              <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry ? nameOf(entry.name) : undefined}>
                {entry && <><Icon name={entry.kind === "dir" ? "Folder" : "File"} /> {nameOf(entry.name)}</>}</td>
              <td>{entry && (entry.kind === "file" ? bytes(entry.size) : "—")}</td>
              <td>{entry && date(entry.mtimeNs, true)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <footer className="cm-meta" style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
        {diff && <>
          {side === "left" ? ru.compareOnlyLeft : ru.compareOnlyRight} {diff[side === "left" ? "onlyLeft" : "onlyRight"].length}
          {" · "}{ru.compareChanged} {diff.differ.length}{" · "}{ru.compareEqual} {diff.same}
        </>}
      </footer>
    </section>)}
  </div>;
}

export function CompareView({ subject, api, close }: { subject: ScanSubject; api: ScanActions; close(): void }) {
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [hideEqual, setHideEqual] = useState(false);
  const last = useRef<Request | null>(null);
  const title = subject.kind === "dirs" ? ru.scanTitle : ru.scanChecksum;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const job = phase.state === "scan" ? phase.view.job : null;
  const scanId = job?.state === "running" ? job.id : null;
  const result = phase.state === "scan" ? phase.view.result : null;
  const diff = result && "onlyLeft" in result ? result : null;
  const expired = phase.state === "unavailable" || (phase.state === "scan" && phase.view.reason === "result_expired");
  const busy = phase.state === "starting" || !!scanId;

  useEffect(() => {
    if (!scanId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(id: string) {
      try {
        const view = await api.get(id);
        if (disposed) return;
        setProblem(null);
        setPhase(view ? { state: "scan", view } : { state: "unavailable" });
        if (view?.job.state !== "running") return;
      } catch (error) {
        if (disposed) return;
        setProblem(problemOf(error));
      }
      timer = setTimeout(() => void poll(id), 250);
    }
    void poll(scanId);
    return () => { disposed = true; clearTimeout(timer); };
  }, [scanId, api.get]);

  async function start(request: Request, estimateId?: string) {
    last.current = request;
    setProblem(null);
    setCancelling(false);
    setPhase({ state: "starting" });
    const refs = request.kind === "checksum" ? [request.ref] : [request.left, request.right];
    const remote = refs.some(({ endpoint }) => endpoint.startsWith("sftp:"));
    try {
      const reply = await api.start({
        ...request,
        ...(estimateId ? { estimateId } : remote ? { estimateOnly: true } : {}),
      });
      setPhase("estimateId" in reply ? { state: "confirm", estimate: reply }
        : { state: "scan", view: { job: reply, result: null } });
    } catch (error) {
      setProblem(problemOf(error));
      setPhase({ state: "idle" });
    }
  }

  function run(by: "size+mtime" | "sha256") {
    void start(subject.kind === "checksum" ? { kind: "checksum", ref: subject.file.ref }
      : { kind: "dirs", left: subject.left.ref, right: subject.right.ref, by, mtimeToleranceMs: 2000, limit: 1000 });
  }

  async function cancel(id: string) {
    setCancelling(true);
    try { await api.cancel(id); }
    catch (error) { setProblem(problemOf(error)); setCancelling(false); }
  }

  const facts = diff && [
    [ru.compareOnlyLeft, diff.onlyLeft.length], [ru.compareOnlyRight, diff.onlyRight.length],
    [ru.compareChanged, diff.differ.length], [ru.compareEqual, diff.same],
  ] as const;
  const progress = job?.progress;
  const planned = BigInt(progress?.bytesPlanned ?? "0");
  const percent = planned > 0n ? Math.min(100, Number(BigInt(progress!.bytes) * 100n / planned)) : undefined;
  return <>
    <header className="cm-heading">
      <Button size="sm" variant="outline" onClick={close} disabled={busy}><Icon name="ArrowLeft" />{ru.close}</Button>
      <h1 ref={heading} tabIndex={-1} style={{ outline: "none" }}>{title}</h1>
    </header>
    <div style={{ display: "flex", flexWrap: "wrap", flex: 1, minHeight: 0, overflow: "auto" }}>
      {subject.kind === "dirs"
        ? <DirectoryComparison subject={subject} diff={diff} hideEqual={hideEqual} controls={
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Button size="sm" variant="outline" disabled={busy || phase.state === "confirm"}
              aria-pressed={last.current?.kind === "dirs" && last.current.by === "size+mtime"}
              aria-label={ru.scanMetadata} onClick={() => run("size+mtime")}>{ru.scanMetadataShort}</Button>
            <Button size="sm" variant="outline" disabled={busy || phase.state === "confirm"}
              aria-pressed={last.current?.kind === "dirs" && last.current.by === "sha256"}
              aria-label={ru.scanHashes} onClick={() => run("sha256")}>SHA-256</Button>
            {diff && <label className="cm-meta" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={hideEqual} onChange={(event) => setHideEqual(event.currentTarget.checked)} />
              {ru.scanHideEqual}
            </label>}
          </div>
        } />
        : <section className="cm-pane" style={{ padding: 16, gap: 10, flex: "1 1 360px" }}>
          <strong>{subject.file.label}</strong>
          <code>{shortPath(subject.file.ref.path)}</code>
          {result && "sha256" in result && <output aria-label="SHA-256" style={{ overflowWrap: "anywhere" }}>{result.sha256}</output>}
        </section>}
      <aside className="cm-queue" aria-label={title} style={{ padding: 16, flex: "1 1 280px", maxWidth: 320 }}>
        <h2 style={{ padding: 0 }}>{title}</h2>
        {diff && last.current?.kind === "dirs" && <p className="cm-meta">
          {last.current.by === "size+mtime" ? ru.scanTolerance : ru.scanHashes}
        </p>}
        {facts && <dl className="cm-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {job?.partial && job.state === "done" && <p role="status">{ru.scanPartial}</p>}
        {phase.state === "starting" && <p role="status">{ru.busy}</p>}
        {phase.state === "confirm" && <>
          <p role="status">{ru.scanEstimate(bytes(phase.estimate.bytesPlanned))}</p>
          <div className="cm-actions">
            <Button size="sm" onClick={() => { if (last.current) void start(last.current, phase.estimate.estimateId); }}>{ru.scanConfirm}</Button>
            <Button size="sm" variant="outline" onClick={() => setPhase({ state: "idle" })}>{ru.cancel}</Button>
          </div>
        </>}
        {scanId && <>
          <p role="status">{ru.scanProgress(progress!.items, bytes(progress!.bytes))}</p>
          <progress aria-label={ru.scanProgressLabel} max={100} value={percent} style={{ width: "100%" }} />
          <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void cancel(scanId)}>{ru.scanCancel}</Button>
        </>}
        {problem && <ProblemLine problem={problem} />}
        {job?.state === "failed" && job.error && <ProblemLine problem={problemOf(job.error)} />}
        {job?.state === "cancelled" && <p role="status">{stateText.cancelled}</p>}
        {job?.state === "interrupted" && <p role="status">{ru.scanInterrupted}</p>}
        {expired && <p role="status">{ru.scanExpired}</p>}
        {!busy && phase.state !== "confirm" && <div className="cm-actions" style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
          {(expired || job?.state === "interrupted" || job?.state === "failed" || job?.state === "cancelled") && last.current
            ? <Button size="sm" onClick={() => { if (last.current) void start(last.current); }}>{ru.scanRetry}</Button>
            : subject.kind === "checksum" && <Button size="sm" onClick={() => run("sha256")}>{ru.scanCalculate}</Button>}
        </div>}
      </aside>
    </div>
  </>;
}
