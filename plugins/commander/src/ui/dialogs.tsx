import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ConflictAction, Fingerprint, OperationJob, OperationPlan, ResourceRef } from "../core/model.ts";
import { displayPath, parent } from "../core/path.ts";
import type { AgentGrant } from "../core/wire/rpc.ts";
import { isAncestorOrSelf } from "../core/path.ts";
import { bytes, date, nameOf, problemOf, shortPath, type EndpointView, type PlanCheck, type Problem } from "./model.ts";
import { ProblemLine } from "./pane.tsx";
import { operationText, reasonText, ru } from "./strings.ts";

export function Modal({ title, description, close, children, busy }: {
  title: string; description?: string; close: () => void; children: ReactNode; busy?: boolean;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent className="cm-dialog" hideCloseButton compactContentClassName="cm-dialog-drawer"
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => { event.preventDefault(); if (!busy) close(); }}
      onPointerDownOutside={(event) => event.preventDefault()}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription className={description ? "cm-dialog-description" : "sr-only"}>{description ?? title}</DialogDescription>
      {children}
    </DialogContent>
  </Dialog>;
}

export function TextDialog({ title, label, initial = "", submit, close, busy, error }: {
  title: string; label: string; initial?: string; submit: (text: string) => void; close: () => void; busy: boolean; error: Problem | null;
}) {
  const [text, setText] = useState(initial);
  return <Modal title={title} close={close} busy={busy}>
    <form className="cm-dialog-form" onSubmit={(event) => { event.preventDefault(); if (text) submit(text); }}>
      <label>{label}<Input value={text} onChange={(event) => setText(event.currentTarget.value)} maxLength={1024} required autoFocus /></label>
      {error && <ProblemLine problem={error} />}
      <div className="cm-actions"><Button type="submit" size="sm" disabled={busy}>{ru.next}</Button><Button type="button" size="sm" variant="outline" onClick={close}>{ru.cancel}</Button></div>
    </form>
  </Modal>;
}

function Resource({ value, endpoints }: { value: ResourceRef; endpoints: EndpointView[] }) {
  const endpoint = endpoints.find((entry) => entry.id === value.endpoint);
  return <><small>{endpoint?.label ?? value.endpoint}{endpoint && endpoint.machine !== endpoint.label && <> · {endpoint.machine}</>}</small>
    <code>{displayPath(value.path)}</code></>;
}
const durationFormats = (["day", "hour", "minute", "second"] as const).map((unit) =>
  new Intl.NumberFormat("ru", { style: "unit", unit, unitDisplay: "long" }));
const durationUnits = [86400n, 3600n, 60n, 1n] as const;

function timeDifference(newer: Fingerprint | null, older: Fingerprint | null) {
  if (!newer?.mtimeNs || !older?.mtimeNs) return null;
  const difference = BigInt(newer.mtimeNs) - BigInt(older.mtimeNs);
  if (difference <= 0n) return null;
  const seconds = difference / 1_000_000_000n;
  const unit = durationUnits.findIndex((value) => seconds >= value);
  return unit === -1 ? ru.lessThanSecond : durationFormats[unit].format(seconds / durationUnits[unit]);
}

function FingerprintCard({ label, value, other, refValue, endpoints }: {
  label: string; value: Fingerprint | null; other: Fingerprint | null;
  refValue: ResourceRef | null | undefined; endpoints: EndpointView[];
}) {
  const endpoint = endpoints.find((entry) => entry.id === refValue?.endpoint);
  const name = refValue?.path.segments.at(-1);
  const dir = refValue ? parent(refValue.path) : null;
  const location = dir ? (endpoint?.label ?? refValue!.endpoint) + ":" : "";
  const newer = timeDifference(value, other);
  return <section className="cm-detail cm-fingerprint" aria-label={label}>
    <span className="cm-meta">{label}</span>
    <strong className="cm-fingerprint-name" title={name ? nameOf(name) : undefined}>{name ? nameOf(name) : "—"}</strong>
    <span className="cm-meta cm-fingerprint-path" title={dir ? location + displayPath(dir) : undefined}>
      {dir ? location + shortPath(dir) : "—"}
    </span>
    <dl className="cm-facts">
      <dt>{ru.size}</dt><dd>{value ? bytes(value.size) : "—"}</dd>
      <dt>{ru.date}</dt><dd>{value ? date(value.mtimeNs, true) : "—"}</dd>
    </dl>
    <div className="cm-freshness">{newer && <span className="cm-good">{ru.newer(newer)}</span>}</div>
    {value?.sha256 && <code title={value.sha256}>{value.sha256}</code>}
    {!value && <span className="cm-meta">{ru.noFingerprint}</span>}
  </section>;
}

export function ConflictDialog({ job, endpoints, decide, compare, cancel, close, busy, error, same, onSame }: {
  job: OperationJob; endpoints: EndpointView[]; decide: (action: ConflictAction, same: boolean) => void;
  compare: (source: ResourceRef, target: ResourceRef) => void; cancel: () => void; close: () => void;
  busy: boolean; error: Problem | null; same: boolean; onSame: (same: boolean) => void;
}) {
  const conflict = job.pendingConflict;
  if (!conflict) return null;
  const item = job.plan.items[conflict.itemIndex];
  const allowed = new Set(conflict.allowedResolutions ?? ["overwrite", "skip", "rename", "cancel"]);
  const controls = [
    { action: "overwrite", label: ru.replace, key: "Enter" },
    { action: "skip", label: ru.skip, key: "s" },
    { action: "rename", label: ru.keepBoth, key: "r" },
  ] as const;
  const source = item?.source, target = item?.target;
  const name = (target ?? source)?.path.segments.at(-1);
  const title = name ? conflict.reason === "exists" ? ru.conflictExists(nameOf(name))
    : ru.conflictForFile(nameOf(name), reasonText[conflict.reason]) : reasonText[conflict.reason];
  const localTarget = !!target && endpoints.some((endpoint) => endpoint.id === target.endpoint && endpoint.provider === "local");
  const localFile = (ref: ResourceRef) => ref.path.segments.every((segment) => "t" in segment)
    && endpoints.some((endpoint) => endpoint.id === ref.endpoint && endpoint.provider === "local" && endpoint.hostId);
  return <Modal title={title} description={operationText[job.plan.kind]}
    close={close} busy={busy}>
    <div className="cm-pair">
      <FingerprintCard label={ru.source} value={conflict.source} other={conflict.target} refValue={source} endpoints={endpoints} />
      <FingerprintCard label={ru.existing} value={conflict.target} other={conflict.source} refValue={target} endpoints={endpoints} />
    </div>
    {error && <ProblemLine problem={error} />}
    <div className="cm-actions">
      {controls.filter(({ action }) => allowed.has(action)).map(({ action, label, key }) =>
        <Button key={action} size="sm" variant={action === "overwrite" ? "default" : "outline"} className={action === "overwrite" ? "cm-primary" : undefined} disabled={busy}
          onClick={() => decide(action, same)}>{label} <kbd>{key === "Enter" ? "↵" : key.toUpperCase()}</kbd></Button>)}
      {item?.kind === "file" && source && target && localFile(source) && localFile(target) &&
        <Button size="sm" variant="outline" onClick={() => compare(source, target)}>{ru.content}</Button>}
    </div>
    <label className="cm-checkbox"><Checkbox checked={same} onCheckedChange={(value) => onSame(value === true)} />{ru.sameReason}</label>
    {allowed.has("overwrite") && <small className="cm-meta">{localTarget ? ru.atomicLocal : ru.atomicUnavailable}</small>}
    <div className="cm-actions">
      <small className="cm-meta cm-job-id" title={job.id}>{job.id}</small>
      {allowed.has("cancel") && <Button size="sm" variant="outline" disabled={busy} onClick={cancel}>{ru.cancelJob}</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>{ru.close} <kbd>Esc</kbd></Button>
    </div>
  </Modal>;
}

function PlanDetails({ plan, endpoints, grants }: { plan: OperationPlan; endpoints: EndpointView[]; grants: AgentGrant[] }) {
  const [itemPage, setItemPage] = useState(0);
  const pageSize = 25;
  const mutation = plan.kind === "delete" || plan.kind === "move";
  const first = plan.items[0];
  const source = first?.source;
  const target = plan.targetDir ?? first?.target;
  const matching = plan.initiator.kind === "agent" ? grants.filter((grant) =>
    (source && (grant.endpoint === "*" || grant.endpoint === source.endpoint) && isAncestorOrSelf(grant.scope, source.path, true)) ||
    (target && (grant.endpoint === "*" || grant.endpoint === target.endpoint) && isAncestorOrSelf(grant.scope, target.path, true))) : [];
  return <>
    <div className="cm-pair">
      {source && <div className="cm-detail"><strong>{ru.source}</strong><Resource value={source} endpoints={endpoints} /></div>}
      {target && <div className="cm-detail"><strong>{ru.target}</strong><Resource value={target} endpoints={endpoints} /></div>}
    </div>
    <dl className="cm-facts">
      <dt>{ru.items}</dt><dd>{plan.items.length} · {bytes(plan.totalBytes)}</dd>
      <dt>{ru.route}</dt><dd>{plan.route === "same-endpoint" ? ru.sameEndpoint : ru.relay}</dd>
      <dt>{ru.verify}</dt><dd>{plan.verify === "sha256" ? "SHA-256" : ru.bySize}</dd>
      {plan.initiator.kind === "agent" && <><dt>{ru.grants}</dt><dd>{matching.length
        ? matching.map((grant) => grant.permissions.join(", ")).join(" · ") : ru.noGrants}</dd></>}
    </dl>
    {plan.items.length > 1 && <details>
      <summary>{ru.allItems} · {plan.items.length}</summary>
      <ol start={itemPage * pageSize + 1}>{plan.items.slice(itemPage * pageSize, (itemPage + 1) * pageSize).map((item, index) =>
        <li key={index}>{item.source && <Resource value={item.source} endpoints={endpoints} />}
          {item.target && <Resource value={item.target} endpoints={endpoints} />}</li>)}</ol>
      <div className="cm-actions">
        <Button size="sm" variant="outline" disabled={itemPage === 0} onClick={() => setItemPage(itemPage - 1)}>←</Button>
        <span>{itemPage + 1} / {Math.ceil(plan.items.length / pageSize)}</span>
        <Button size="sm" variant="outline" disabled={(itemPage + 1) * pageSize >= plan.items.length} onClick={() => setItemPage(itemPage + 1)}>→</Button>
      </div>
    </details>}
    {mutation && <p className="cm-warning">{ru.removeSource} · {ru.irreversible}</p>}
    <p className="cm-meta">{ru.frozen}</p>
  </>;
}

export function PlanDialog({ plan, job, endpoints, inspect, run, reject, openThread, close, busy, error }: {
  plan: OperationPlan; job?: OperationJob; endpoints: EndpointView[];
  inspect: (job: OperationJob) => Promise<{ check: PlanCheck; grants: AgentGrant[] }>;
  run: () => void; reject: () => void; openThread: (threadId: string) => void; close: () => void;
  busy: boolean; error: Problem | null;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof inspect>> | null>(null);
  const [checkError, setCheckError] = useState<Problem | null>(null);
  useEffect(() => {
    if (!job) return;
    let live = true;
    void inspect(job).then((value) => { if (live) setResult(value); }, (failure) => { if (live) setCheckError(problemOf(failure)); });
    return () => { live = false; };
  }, [job, inspect]);
  const { check, grants } = result ?? {};
  const threadId = plan.initiator.kind === "agent" ? plan.initiator.threadId : null;
  return <Modal title={operationText[plan.kind]} description={threadId ? ru.thread + " " + threadId : undefined}
    close={close} busy={busy}>
    <div className="cm-meta">{ru.stagedAt} <time dateTime={plan.createdAt}>{date(plan.createdAt)}</time></div>
    {job && (checkError ? <ProblemLine problem={checkError} /> : check ? <div role="status" className={check.ok ? "cm-good" : "cm-warning"}>
      {check.ok ? ru.unchanged : ru.changed} · {ru.checkedAt} <time dateTime={check.checkedAt}>{date(check.checkedAt)}</time>
      {!check.ok && <ul>{check.changed.slice(0, 20).map(({ index, reason }) => <li key={index}>{index + 1}. {reasonText[reason]}</li>)}</ul>}
    </div> : <div role="status">{ru.checking}</div>)}
    <PlanDetails plan={plan} endpoints={endpoints} grants={grants ?? []} />
    {error && <ProblemLine problem={error} />}
    <div className="cm-actions">
      <Button size="sm" className="cm-primary" disabled={busy || !!job && !check?.ok} onClick={run}>{job ? ru.approve : ru.run}</Button>
      {job && <Button size="sm" variant="outline" disabled={busy} onClick={reject}>{ru.reject}</Button>}
      {threadId && <Button size="sm" variant="outline" onClick={() => openThread(threadId)}>{ru.openThread}</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>{ru.close}</Button>
    </div>
  </Modal>;
}
