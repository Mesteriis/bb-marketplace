import { CommanderError, isCommanderError } from "./errors.ts";
import type { EndpointId, Initiator } from "./model.ts";

export type ScanKind = "checksum" | "compare" | "search";
export type ScanState = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface ScanJob {
  id: string;
  kind: ScanKind;
  initiator: Initiator;
  endpoints: EndpointId[];
  state: ScanState;
  progress: { items: number; bytes: bigint; bytesPlanned: bigint | null };
  partial: boolean;
  error: CommanderError | null;
}

export interface ScanContext {
  signal: AbortSignal;
  progress(delta: { items?: number; bytes?: bigint }): void;
  markPartial(reason: string): void;
}

export interface ScanStore {
  save(job: ScanJob): void;
  get(id: string): ScanJob | null;
}

type ScanSpec = Pick<ScanJob, "kind" | "initiator" | "endpoints"> & { bytesPlanned?: bigint | null };
const maxRunning = 8;
const maxResults = 16;

export class ScanRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; job: ScanJob }>();
  private readonly results = new Map<string, unknown>();
  private closed = false;

  constructor(private readonly uuid: () => string, private readonly store?: ScanStore) {}

  start<R>(spec: ScanSpec, work: (ctx: ScanContext) => Promise<R>): ScanJob {
    if (this.closed || this.active.size >= maxRunning) {
      throw new CommanderError("limit_exceeded", "Commander scan pool is unavailable");
    }
    const { kind, initiator, endpoints, bytesPlanned = null } = spec;
    const job: ScanJob = {
      id: this.uuid(), kind, initiator: { ...initiator }, endpoints: [...endpoints], state: "running",
      progress: { items: 0, bytes: 0n, bytesPlanned }, partial: false, error: null,
    };
    this.store?.save(job);
    const controller = new AbortController();
    const { signal } = controller;
    const ctx: ScanContext = {
      signal,
      progress: ({ items = 0, bytes = 0n }) => {
        signal.throwIfAborted();
        job.progress.items += items;
        job.progress.bytes += bytes;
        this.store?.save(job);
      },
      markPartial: () => {
        signal.throwIfAborted();
        job.partial = true;
        this.store?.save(job);
      },
    };
    const done = Promise.resolve().then(async () => {
      let result: R;
      try {
        signal.throwIfAborted();
        result = await work(ctx);
        signal.throwIfAborted();
      } catch (error) {
        job.partial = true;
        job.state = signal.aborted ? "cancelled" : "failed";
        job.error = signal.aborted ? new CommanderError("cancelled", "Scan cancelled")
          : isCommanderError(error) ? error : new CommanderError("internal", "Scan failed");
        this.remember(job, null);
        return;
      }
      job.state = "done";
      this.remember(job, result);
    }).finally(() => this.active.delete(job.id));
    // A caller may poll instead of awaiting completion.
    void done.catch(() => {});
    this.active.set(job.id, { controller, done, job });
    return this.snapshot(job);
  }

  get(id: string): ScanJob | null {
    const live = this.active.get(id)?.job;
    return live ? this.snapshot(live) : this.store?.get(id) ?? this.completed.get(id) ?? null;
  }

  cancel(id: string): void {
    this.active.get(id)?.controller.abort();
  }

  cancelAgent(threadId: string): void {
    for (const { job, controller } of this.active.values()) {
      if (job.initiator.kind === "agent" && (threadId === "*" || job.initiator.threadId === threadId)) {
        controller.abort();
      }
    }
  }

  result<R>(id: string): R | null {
    return (this.results.get(id) as R | undefined) ?? null;
  }

  wait(id: string): Promise<void> {
    return this.active.get(id)?.done ?? Promise.resolve();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const active = [...this.active.values()];
    for (const { controller } of active) controller.abort();
    await Promise.allSettled(active.map(({ done }) => done));
  }

  private readonly completed = new Map<string, ScanJob>();

  private remember(job: ScanJob, result: unknown): void {
    this.store?.save(job);
    this.completed.set(job.id, job);
    this.results.set(job.id, result);
    if (this.results.size > maxResults) {
      const oldest = this.results.keys().next().value!;
      this.results.delete(oldest);
      this.completed.delete(oldest);
    }
  }

  private snapshot(job: ScanJob): ScanJob {
    return { ...job, initiator: { ...job.initiator }, endpoints: [...job.endpoints], progress: { ...job.progress } };
  }
}
