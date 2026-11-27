import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { displayPath } from "../core/path.ts";
import type { Entry, ResourceRef } from "../core/model.ts";
import type { RpcInput, SavedUiScan, ScanEstimateView, ScanGetView } from "../core/wire/rpc.ts";
import { bytes, date, nameOf, problemOf, shortPath, type Problem } from "./model.ts";
import { ProblemLine } from "./pane.tsx";
import { ru, stateText } from "./strings.ts";

type Request = SavedUiScan["request"];
export interface ScanActions {
  start(input: RpcInput<"scan_start">): Promise<ScanGetView["job"] | ScanEstimateView>;
  get(id: string): Promise<ScanGetView | null>;
  cancel(id: string): Promise<unknown>;
}

type Target = { ref: ResourceRef; label: string; readOnly: boolean };
export type ScanSubject = { kind: "dirs"; left: Target; right: Target } | { kind: "checksum"; file: Target };
type Phase = { state: "idle" | "starting" }
  | { state: "confirm"; estimate: ScanEstimateView }
  | { state: "restoring"; id: string }
  | { state: "scan"; view: ScanGetView }
  | { state: "unavailable" };

type Difference = Extract<NonNullable<ScanGetView["result"]>, { onlyLeft: Entry[] }>;
const columns = ["left", "right"] as const;

function DirectoryComparison({ subject, diff, controls, hideEqual }: {
  subject: Extract<ScanSubject, { kind: "dirs" }>; diff: Difference | null; controls: ReactNode; hideEqual: boolean;
}) {
  const rows = diff ? [
    ...diff.differ.map(([left, right]) => ({ left, right, mark: "≠", tone: "different" })),
    ...diff.onlyLeft.map((left) => ({ left, right: null, mark: "+", tone: "left" })),
    ...diff.onlyRight.map((right) => ({ left: null, right, mark: "+", tone: "right" })),
    ...(hideEqual ? [] : diff.equal ?? []).map(([left, right]) => ({
      left, right, mark: "=", tone: "equal",
    })),
  ].sort((a, b) => nameOf((a.left ?? a.right)!.name).localeCompare(nameOf((b.left ?? b.right)!.name), "ru")) : [];
  return <div className="cm-scan-panes">
    {columns.map((side) => <section className="cm-pane cm-scan-pane" key={side}>
      <header>
        <strong className="cm-meta">{subject[side].label} · {subject[side].ref.endpoint.startsWith("sftp:") ? ru.sftp : ru.local} · {
          subject[side].readOnly ? ru.readOnly : ru.writable}</strong>
        <code className="cm-address cm-scan-path" title={displayPath(subject[side].ref.path)}>{displayPath(subject[side].ref.path)}</code>
        <div className="cm-scan-controls">{side === "left" && controls}</div>
      </header>
      <div className="cm-scan-rows">
        <table aria-label={ru[side]}>
          <thead><tr>
            <th aria-label={ru.scanDifference} className="cm-scan-mark" /><th>{ru.name}</th>
            <th className="cm-scan-size">{ru.size}</th><th className="cm-scan-date">{ru.date}</th>
          </tr></thead>
          <tbody>{rows.map((row, index) => {
            const entry = row[side];
            return <tr key={index} data-tone={row.tone}>
              <td className="cm-scan-mark">{entry && row.mark}</td>
              <td title={entry ? nameOf(entry.name) : undefined}>
                {entry && <><Icon name={entry.kind === "dir" ? "Folder" : "File"} /> {nameOf(entry.name)}</>}</td>
              <td>{entry && (entry.kind === "file" ? bytes(entry.size) : entry.kind === "dir" ? "<DIR>" : "—")}</td>
              <td>{entry && date(entry.mtimeNs, true)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <footer className="cm-meta">
        {diff && <>
          {side === "left" ? ru.compareOnlyLeft : ru.compareOnlyRight} {diff[side === "left" ? "onlyLeft" : "onlyRight"].length}
          {" · "}{ru.compareChanged} {diff.differ.length}{" · "}{ru.compareEqual} {diff.same}
        </>}
      </footer>
    </section>)}
  </div>;
}

export function CompareView({ subject, api, saved, remember, close }: {
  subject: ScanSubject; api: ScanActions; saved?: SavedUiScan; remember(scan: SavedUiScan): void; close(): void;
}) {
  const [phase, setPhase] = useState<Phase>(() => saved ? { state: "restoring", id: saved.scanId } : { state: "idle" });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [hideEqual, setHideEqual] = useState(false);
  const last = useRef<Request | null>(saved?.request ?? null);
  const title = subject.kind === "dirs" ? ru.scanTitle : ru.scanChecksum;
  const heading = useRef<HTMLHeadingElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const job = phase.state === "scan" ? phase.view.job : null;
  const scanId = job?.state === "running" ? job.id : null;
  const pollId = phase.state === "restoring" ? phase.id : scanId;
  const result = phase.state === "scan" ? phase.view.result : null;
  const diff = result && "onlyLeft" in result ? result : null;
  const expired = phase.state === "unavailable" || (phase.state === "scan" && phase.view.reason === "result_expired");
  const busy = phase.state === "starting" || !!pollId;
  useEffect(() => { if (phase.state === "confirm") confirm.current?.focus(); }, [phase.state]);

  useEffect(() => {
    if (!pollId) return;
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
    void poll(pollId);
    return () => { disposed = true; clearTimeout(timer); };
  }, [pollId, api.get]);

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
      if ("estimateId" in reply) setPhase({ state: "confirm", estimate: reply });
      else {
        remember({ scanId: reply.id, request });
        setPhase({ state: "scan", view: { job: reply, result: null } });
      }
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
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  const targets = subject.kind === "dirs" ? [subject.left, subject.right] : [subject.file];
  return <section className="cm-scan" onKeyDown={onKeyDown} aria-label={title}>
    <header className="cm-heading">
      <Button size="sm" variant="outline" onClick={close}><Icon name="ArrowLeft" />{ru.close}</Button>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
    </header>
    <div className="cm-scan-layout">
      {subject.kind === "dirs"
        ? <DirectoryComparison subject={subject} diff={diff} hideEqual={hideEqual} controls={
          <div className="cm-scan-modes">
            <Button size="sm" variant="outline" disabled={busy || phase.state === "confirm"}
              aria-pressed={last.current?.kind === "dirs" && last.current.by === "size+mtime"}
              aria-label={ru.scanMetadata} onClick={() => run("size+mtime")}>{ru.scanMetadataShort}</Button>
            <Button size="sm" variant="outline" disabled={busy || phase.state === "confirm"}
              aria-pressed={last.current?.kind === "dirs" && last.current.by === "sha256"}
              aria-label={ru.scanHashes} onClick={() => run("sha256")}>SHA-256</Button>
            <span className="cm-scan-tolerance">{ru.scanToleranceShort}</span>
            {diff && <label className="cm-meta">
              <input type="checkbox" checked={hideEqual} onChange={(event) => setHideEqual(event.currentTarget.checked)} />
              {ru.scanHideEqual}
            </label>}
          </div>
        } />
        : <section className="cm-pane cm-scan-file">
          <strong>{subject.file.label}</strong>
          <code>{shortPath(subject.file.ref.path)}</code>
          {result && "sha256" in result && <output aria-label="SHA-256">{result.sha256}</output>}
        </section>}
      <aside className="cm-scan-side" aria-label={title}>
        <h2>{title}</h2>
        {diff && last.current?.kind === "dirs" && <p className="cm-meta">
          {last.current.by === "size+mtime" ? ru.scanTolerance : ru.scanHashes}
        </p>}
        {facts && <dl className="cm-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {job?.partial && job.state === "done" && <p role="status">{ru.scanPartial}</p>}
        {(phase.state === "starting" || phase.state === "restoring") && <p role="status">{ru.busy}</p>}
        {phase.state === "confirm" && <>
          <div className="cm-scan-estimate">
            {(last.current?.kind === "checksum" || last.current?.by === "sha256") && <strong>{ru.scanHashes}</strong>}
            <p role="status">{ru.scanReadBreakdown(phase.estimate.bytesByEndpoint.map(({ endpoint, bytesPlanned }) =>
              endpoint.startsWith("sftp:") ? ru.scanRemoteBytes(bytes(bytesPlanned), targets.find((target) => target.ref.endpoint === endpoint)?.label ?? endpoint)
                : ru.scanLocalBytes(bytes(bytesPlanned))).join(ru.scanAnd))}</p>
            <p className="cm-meta">{ru.scanEstimate(bytes(phase.estimate.bytesPlanned))}</p>
          </div>
          <div className="cm-actions cm-scan-actions">
            <Button ref={confirm} size="sm" onClick={() => { if (last.current) void start(last.current, phase.estimate.estimateId); }}>{ru.scanConfirm}</Button>
            <Button size="sm" variant="outline" onClick={() => setPhase({ state: "idle" })}>{ru.cancel}</Button>
          </div>
        </>}
        {scanId && <>
          <p role="status">{ru.scanProgress(progress!.items, bytes(progress!.bytes))}</p>
          <progress aria-label={ru.scanProgressLabel} max={100} value={percent} />
          <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void cancel(scanId)}>{ru.scanCancel}</Button>
        </>}
        {problem && <ProblemLine problem={problem} />}
        {job?.state === "failed" && job.error && <ProblemLine problem={problemOf(job.error)} />}
        {job?.state === "cancelled" && <p role="status">{stateText.cancelled}</p>}
        {job?.state === "interrupted" && <p role="status">{ru.scanInterrupted}</p>}
        {expired && <p role="status">{ru.scanExpired}</p>}
        {!busy && phase.state !== "confirm" && <div className="cm-actions cm-scan-actions">
          {(expired || job?.state === "interrupted" || job?.state === "failed" || job?.state === "cancelled") && last.current
            ? <Button size="sm" onClick={() => { if (last.current) void start(last.current); }}>{ru.scanRetry}</Button>
            : subject.kind === "checksum" && <Button size="sm" onClick={() => run("sha256")}>{ru.scanCalculate}</Button>}
        </div>}
      </aside>
    </div>
  </section>;
}
