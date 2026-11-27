import type { Fingerprint, JobState, OperationJob } from "./model.ts";
import type { ResourcePath } from "./path.ts";
import type { Size } from "./size.ts";

export interface Checkpoint {
  jobId: string;
  itemIndex: number;
  phase: "prepared" | "copying" | "committed" | "verified" | "source_removed";
  bytesDone: Size;
  tempPath: ResourcePath | null;
  targetPath: ResourcePath | null;
  expectTarget: Fingerprint | "absent" | null;
  verified: { size: Size; sha256?: string } | null;
  /** Fingerprint returned by commit, retained through later phases. */
  committed?: Fingerprint;
}

export interface JobStore {
  create(job: OperationJob): Promise<void>;
  get(id: string): Promise<OperationJob | null>;
  list(filter: { states?: JobState[]; limit: number }): Promise<OperationJob[]>;

  /** Apply the patch atomically if the job still has the expected state. */
  update(
    id: string,
    patch: Partial<Pick<OperationJob, "state" | "progress" | "currentItem" | "pendingConflict" | "items" | "error" | "updatedAt" | "awaitsOwner">>,
    expectState: JobState,
  ): Promise<boolean>;

  checkpoint(checkpoint: Checkpoint): Promise<void>;
  lastCheckpoint(jobId: string, itemIndex: number): Promise<Checkpoint | null>;
}
