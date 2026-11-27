import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { OperationJob } from "../core/model.ts";
import { displayPath } from "../core/path.ts";
import { bytes, damaged, date, shortPath, type EndpointView, type JobView, type Problem } from "./model.ts";
import { ProblemLine } from "./pane.tsx";
import { approvalState, operationText, reasonText, ru, stateText } from "./strings.ts";

const plurals = new Intl.PluralRules("ru");
const pluralIndex = { one: 0, few: 1, many: 2, other: 2, two: 2, zero: 2 } as const;
const cancellable = new Set(["pending", "running", "awaiting_decision", "interrupted"]);
// S17: только задания, у которых есть невыполненные элементы (failed или unknown).
const retryable = new Set(["failed", "unknown"]);
// Временная строка до переноса в strings.ts (владеет S8).
const retryUnfinished = "Повторить невыполненное";
const stateIcons = {
  pending: "Clock", approval: "Lock", running: "Play", awaiting_decision: "CircleQuestion",
  completed: "CircleCheck", failed: "AlertTriangle", cancel_requested: "Clock",
  cancelled: "CircleX", interrupted: "Pause", unknown: "CircleQuestion",
};

function JobCard({ job, endpoints, compact, onInspect, onSkip, onCancel, onRetry }: {
  job: JobView; endpoints: EndpointView[]; compact?: boolean;
  onInspect: (job: OperationJob) => void; onSkip: (job: OperationJob) => void; onCancel: (job: OperationJob) => void;
  onRetry?: (job: OperationJob) => void;
}) {
  if (damaged(job)) return <article className="cm-job" aria-label={ru.damaged}>
    <strong>{ru.damaged}</strong><span className="cm-meta">{job.id}</span>
    <time className="cm-meta" dateTime={job.createdAt}>{date(job.createdAt ?? null)}</time>
  </article>;
  const { plan, progress, pendingConflict } = job;
  const endpoint = endpoints.find((entry) => entry.id === (plan.targetEndpoint ?? plan.sourceEndpoint));
  const targetPath = plan.targetDir?.path ?? plan.items[0]?.target?.path;
  const target = targetPath ? displayPath(targetPath) : "";
  const compactTarget = targetPath ? shortPath(targetPath) : "";
  const count = plan.items.length;
  const units = plan.items.every((item) => item.kind === "file") ? ru.fileCount : ru.objectCount;
  const heading = operationText[plan.kind] + " " + count + " " + units[pluralIndex[plurals.select(count)]];
  const total = BigInt(progress.bytesTotal);
  const percent = job.state === "completed" ? 100 : total > 0n
    ? Number(BigInt(progress.bytesDone) * 100n / total)
    : progress.itemsTotal ? Math.floor(progress.itemsDone * 100 / progress.itemsTotal) : 0;
  const state = job.awaitsOwner ? "approval" : job.state;
  const label = state === "approval" ? approvalState : stateText[state];
  const status = <span className="cm-job-tone"><Icon name={stateIcons[state]} aria-hidden="true" />{label}</span>;
  const conflict = job.state === "awaiting_decision" ? pendingConflict : null;

  if (compact) return <article className="cm-job cm-mini-job" aria-label={operationText[plan.kind]} data-state={state}>
    <div className="cm-mini-line">
      <Icon name={plan.initiator.kind === "owner" ? "UserRound" : "Bot"} />
      <span title={target || undefined}>{conflict ? reasonText[conflict.reason] : operationText[plan.kind] + (endpoint ? " → " + endpoint.label : "")}</span>
      {conflict && <Button size="sm" variant="outline" data-conflict-id={conflict.id} onClick={() => onInspect(job)}>{ru.compactResolve}</Button>}
      {job.awaitsOwner && <Button size="sm" variant="outline" onClick={() => onInspect(job)}>{ru.inspectPlan}</Button>}
      {job.state === "running" && <span>{percent}%</span>}
    </div>
    {status}
    {job.state === "running" && <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} className="cm-progress"><span style={{ width: percent + "%" }} /></div>}
  </article>;

  return <article className="cm-job" aria-label={operationText[plan.kind]} data-state={state}>
    <strong><Icon name={plan.initiator.kind === "owner" ? "UserRound" : "Bot"} />
      <span title={target || undefined}>{heading}{endpoint && <> {target ? "→ " : "· "}{endpoint.label}</>}
        {compactTarget && <>:{compactTarget}</>}</span></strong>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="cm-progress">
      <span style={{ width: percent + "%" }} />
    </div>
    <div className="cm-meta">{status} · {plan.initiator.kind === "owner"
      ? ru.owner : ru.thread + " " + plan.initiator.threadId}</div>
    <div className="cm-meta">{progress.itemsDone} / {progress.itemsTotal}
      {total > 0n && <> · {bytes(progress.bytesDone)} / {bytes(progress.bytesTotal)}</>}</div>
    {pendingConflict && <div className="cm-meta">{reasonText[pendingConflict.reason]}</div>}
    {job.error && <ProblemLine problem={{ code: job.error.code, message: "" }} />}
    <div className="cm-actions">
      {conflict && <Button size="sm" data-conflict-id={conflict.id} onClick={() => onInspect(job)}>{ru.resolve}</Button>}
      {conflict && (conflict.allowedResolutions?.includes("skip") ?? true) &&
        <Button size="sm" variant="outline" onClick={() => onSkip(job)}>{ru.skip}</Button>}
      {job.awaitsOwner && <Button size="sm" variant="outline" onClick={() => onInspect(job)}>{ru.inspectPlan}</Button>}
      {cancellable.has(job.state) && !job.awaitsOwner && !conflict &&
        <Button size="sm" variant="outline" onClick={() => onCancel(job)}>{ru.cancelJob}</Button>}
      {onRetry && retryable.has(job.state) && !job.awaitsOwner && !conflict &&
        <Button size="sm" variant="outline" onClick={() => onRetry(job)}>{retryUnfinished}</Button>}
    </div>
  </article>;
}

export type QueueProps = {
  jobs: JobView[]; endpoints: EndpointView[]; error: Problem | null; loading: boolean;
  onInspect: (job: OperationJob) => void; onSkip: (job: OperationJob) => void; onCancel: (job: OperationJob) => void;
  /** S17: optional, so a host without the retry wiring still renders the queue. */
  onRetry?: (job: OperationJob) => void;
};
export function Queue({ compact, open, selection, id, collapse, ...props }: QueueProps & {
  compact?: boolean; open: boolean; id: string; collapse?: () => void; selection: { count: number; size: string; destination: string; fullDestination: string };
}) {
  const active = props.jobs.find((job) => !damaged(job) && (job.state === "running" || job.awaitsOwner));
  const conflict = props.jobs.find((job) => !damaged(job) && job.state === "awaiting_decision");
  const displayed = compact && !open ? [active, conflict].filter((job): job is JobView => !!job) : props.jobs;
  return <aside id={id} className="cm-queue" aria-label={ru.queue} data-open={open}>
    <h2><Icon name="ListTodo" /> {ru.queue}<span className="cm-count">{props.jobs.length}</span>
      {collapse && <Button size="sm" variant="ghost" aria-label={ru.collapseQueue} aria-controls={id} data-close-queue onClick={collapse}><Icon name="PanelRight" /></Button>}
    </h2>
    <div className="cm-jobs">
      {props.error && <ProblemLine problem={props.error} />}
      {props.loading && <div className="cm-empty">{ru.busy}</div>}
      {!props.loading && props.jobs.length === 0 && <div className="cm-empty">{ru.emptyQueue}</div>}
      {displayed.map((job) => <JobCard key={job.id} {...props} job={job} compact={compact && !open} />)}
    </div>
    {!compact && <div className="cm-selection">
      <strong>{ru.selection}</strong>
      <div><span>{ru.items}</span><span>{selection.count}</span></div>
      <div><span>{ru.size}</span><span>{selection.size}</span></div>
      <div><span>{ru.target}</span><span title={selection.fullDestination}>{selection.destination}</span></div>
    </div>}
  </aside>;
}
