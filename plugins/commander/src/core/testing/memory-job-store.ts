import { CommanderError } from "../errors.ts";
import type { Checkpoint, JobStore } from "../job-store.ts";
import { OperationJob } from "../model.ts";

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, OperationJob>();
  private readonly checkpoints = new Map<string, Checkpoint>();

  async create(job: OperationJob): Promise<void> {
    if (this.jobs.has(job.id)) throw new CommanderError("already_exists", "Job already exists");
    this.jobs.set(job.id, OperationJob.parse(job));
  }

  async get(id: string): Promise<OperationJob | null> {
    return structuredClone(this.jobs.get(id) ?? null);
  }

  async list({ states, limit }: Parameters<JobStore["list"]>[0]): Promise<OperationJob[]> {
    return structuredClone([...this.jobs.values()]
      .filter((job) => !states || states.includes(job.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit));
  }

  async update(id: string, patch: Parameters<JobStore["update"]>[1], expectState: OperationJob["state"]): Promise<boolean> {
    const job = this.jobs.get(id);
    if (job?.state !== expectState) return false;
    const updated = { ...job, ...patch };
    if (job.state === "pending" && updated.state !== "pending") updated.awaitsOwner = false;
    this.jobs.set(id, OperationJob.parse(updated));
    return true;
  }

  async checkpoint(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(this.checkpointKey(checkpoint.jobId, checkpoint.itemIndex), structuredClone(checkpoint));
  }

  async lastCheckpoint(jobId: string, itemIndex: number): Promise<Checkpoint | null> {
    return structuredClone(this.checkpoints.get(this.checkpointKey(jobId, itemIndex)) ?? null);
  }

  private checkpointKey(jobId: string, itemIndex: number): string {
    return JSON.stringify([jobId, itemIndex]);
  }
}
