import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { OperationPlan } from "../core/model.ts";
import { displayPath } from "../core/path.ts";
import type { SyncPlan, SyncRequest } from "../core/sync.ts";
import type { ScanEstimateView } from "../core/wire/rpc.ts";
import { nameOf, problemOf } from "./model.ts";
import { ProblemLine } from "./pane.tsx";
import { ru } from "./strings.ts";

type SyncPaths = Pick<SyncRequest, "left" | "right">;
export interface SyncActions {
  estimate(request: SyncPaths): Promise<ScanEstimateView>;
  create(request: SyncRequest, estimateId?: string): Promise<SyncPlan>;
  run(plan: OperationPlan): Promise<unknown>;
}

function bytes(value: string | bigint) {
  const size = BigInt(value);
  const format = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  if (size < 1000n) return format.format(size) + " " + ru.sync.units[0];
  if (size < 1_000_000n) return format.format(Number(size / 100n) / 10) + " " + ru.sync.units[1];
  if (size < 1_000_000_000n) return format.format(Number(size / 100_000n) / 10) + " " + ru.sync.units[2];
  return format.format(Number(size / 100_000_000n) / 10) + " " + ru.sync.units[3];
}

function PlanFiles({ plan }: { plan: OperationPlan }) {
  return <details>
    <summary>{ru.sync.files(plan.items.length)}</summary>
    <ul className="cm-grid">
      {plan.items.map(({ source, target }, index) => <li key={index} className="break-all">
        {source && displayPath(source.path)}{target && <> → {displayPath(target.path)}</>}
      </li>)}
    </ul>
  </details>;
}

export function SyncDialog({ paths, labels, api, close }: {
  paths: SyncPaths; labels: [string, string]; api: SyncActions; close(): void;
}) {
  const [direction, setDirection] = useState<SyncRequest["direction"]>("left-to-right");
  const [by, setBy] = useState<SyncRequest["by"]>("size+mtime");
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [estimate, setEstimate] = useState<ScanEstimateView | null>(null);
  const [sync, setSync] = useState<SyncPlan | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof problemOf> | null>(null);
  const remoteHash = by === "sha256" && [paths.left, paths.right].some(({ endpoint }) => endpoint.startsWith("sftp:"));

  function perform(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    void action().catch((error: unknown) => setProblem(problemOf(error))).finally(() => setBusy(false));
  }

  function reset() {
    setSync(null);
    setEstimate(null);
    setConfirmDelete(false);
    setProblem(null);
  }

  function prepare() {
    perform(async () => {
      if (remoteHash && !estimate) {
        setEstimate(await api.estimate(paths));
        return;
      }
      const estimateId = estimate?.estimateId;
      setEstimate(null);
      const result = await api.create({ ...paths, direction, by, includeDeletes: direction !== "both" && includeDeletes }, estimateId);
      setChosen(result.copies.map(({ id }) => id));
      setSubmitted([]);
      setSync(result);
    });
  }

  const pending = sync?.copies.filter(({ id }) => chosen.includes(id) && !submitted.includes(id)) ?? [];
  const deletion = sync?.deletes;
  const count = pending.reduce((total, plan) => total + plan.items.length, 0);
  const transfer = pending.reduce((total, plan) => total + (plan.route === "relay-server" ? BigInt(plan.totalBytes) : 0n), 0n);
  const toLabel = (plan: OperationPlan) => {
    const right = plan.targetDir?.endpoint === paths.right.endpoint &&
      displayPath(plan.targetDir.path) === displayPath(paths.right.path);
    return labels[right ? 1 : 0];
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent className="cm-dialog" hideCloseButton
      style={{ width: "min(760px, calc(100vw - 32px))", maxWidth: 760, maxHeight: "calc(100dvh - 32px)", overflowY: "auto" }}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <DialogTitle>{ru.sync.title}</DialogTitle>
      <DialogDescription className="cm-dialog-description break-all">
        {labels[0]} · {displayPath(paths.left.path)} {direction === "both" ? "↔" : direction === "right-to-left" ? "←" : "→"} {labels[1]} · {displayPath(paths.right.path)}
      </DialogDescription>
      <fieldset disabled={busy} className="cm-detail border-y border-border py-3">
        <legend>{ru.sync.direction}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(["left-to-right", "right-to-left", "both"] as const).map((value) => <label key={value} className="flex items-center gap-2">
            <input type="radio" name="sync-direction" checked={direction === value} onChange={() => { setDirection(value); reset(); }} />
            {ru.sync.directions[value]}
          </label>)}
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={by === "sha256"} onChange={(event) => { setBy(event.currentTarget.checked ? "sha256" : "size+mtime"); reset(); }} />
          {ru.sync.compareHash}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={direction === "both"} checked={direction !== "both" && includeDeletes}
            onChange={(event) => { setIncludeDeletes(event.currentTarget.checked); reset(); }} />
          {ru.sync.planDeletes}
        </label>
      </fieldset>

      {estimate && <p role="status">{ru.sync.estimate(bytes(estimate.bytesPlanned))}</p>}
      {sync && <div className="cm-detail">
        {sync.copies.map((plan) => {
          const done = submitted.includes(plan.id);
          return <section key={plan.id} className="cm-detail rounded-md border border-border p-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={busy || done} checked={chosen.includes(plan.id)} onChange={(event) => {
                const checked = event.currentTarget.checked;
                setChosen((previous) => checked ? [...previous, plan.id] : previous.filter((id) => id !== plan.id));
              }} />
              <strong>{plan.conflictPolicy === "overwriteIfNewer" ? ru.sync.update : ru.sync.copy} → {toLabel(plan)}</strong>
              <span className="ml-auto">{done ? ru.sync.queued : plan.items.length + " · " + bytes(plan.totalBytes)}</span>
            </label>
            <PlanFiles plan={plan} />
          </section>;
        })}
        {sync.conflicts.length > 0 && <details className="rounded-md border border-border p-3">
          <summary>{ru.sync.unchanged(sync.conflicts.length)}</summary>
          <ul>
            {sync.conflicts.map(({ left, right, reason }, index) => <li key={index} className="break-all">
              {nameOf(left.name)} · {bytes(left.size)} ↔ {bytes(right.size)} · {ru.sync.reasons[reason]}
            </li>)}
          </ul>
        </details>}
        <section className="cm-detail" style={{
          borderColor: "color-mix(in srgb, var(--destructive, #db6a73) 55%, var(--border))",
          backgroundColor: "color-mix(in srgb, var(--destructive, #db6a73) 7%, var(--background))",
        }}>
          <h3 className="font-semibold">{ru.sync.deletes}</h3>
          {deletion ? <>
            <PlanFiles plan={deletion} />
            {submitted.includes(deletion.id) ? <p role="status">{ru.sync.deletesQueued}</p> : <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={confirmDelete} disabled={busy} onChange={(event) => setConfirmDelete(event.currentTarget.checked)} />
                {ru.sync.selectDeletes(deletion.items.length)}
              </label>
              <p>{bytes(deletion.totalBytes)} · {ru.sync.deletePermission}</p>
              <Button type="button" size="sm" variant="destructive" disabled={!confirmDelete || busy}
                onClick={() => perform(async () => {
                  await api.run(deletion);
                  setSubmitted((previous) => [...previous, deletion.id]);
                  setConfirmDelete(false);
                })}>{ru.sync.confirmDeletes}</Button>
            </>}
          </> : <p>{includeDeletes && direction !== "both" ? ru.sync.nothingToDelete : ru.sync.deletesOff}</p>}
        </section>
        <p className="text-muted-foreground">{ru.sync.recheck}</p>
      </div>}
      {problem && <ProblemLine problem={problem} />}
      <div className="cm-actions flex-wrap">
        {sync && <span className="mr-auto">{ru.sync.summary(count, bytes(transfer))}</span>}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
          {submitted.length ? ru.close : ru.cancel}
        </Button>
        {sync ? <Button type="button" size="sm" className="cm-primary" disabled={busy || pending.length === 0}
          onClick={() => perform(async () => {
            for (const plan of pending) {
              await api.run(plan);
              setSubmitted((previous) => [...previous, plan.id]);
            }
          })}>{ru.sync.confirmPlan}</Button>
          : <Button type="button" size="sm" className="cm-primary" disabled={busy} onClick={prepare}>
            {estimate ? ru.sync.confirmRead : busy ? ru.sync.preparing : ru.sync.build}
          </Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
