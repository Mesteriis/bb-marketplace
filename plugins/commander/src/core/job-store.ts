import type { Fingerprint, JobState, OperationJob } from "./model.ts";
import type { ResourcePath } from "./path.ts";
import type { Size } from "./size.ts";

export interface Checkpoint {
  jobId: string;
  itemIndex: number;
  phase: "prepared" | "copying" | "committed" | "verified" | "source_removed";
  bytesDone: Size;
  tempPath: ResourcePath | null;
  /** Last observed version of the temporary file after a confirmed write. */
  tempFingerprint?: Fingerprint;
  /** Actual route taken by this item, including a failed rename's copy fallback. */
  via?: "rename" | "copy";
  targetPath: ResourcePath | null;
  expectTarget: Fingerprint | "absent" | null;
  verified: { size: Size; sha256?: string } | null;
  /** Fingerprint returned by commit, retained through later phases. */
  committed?: Fingerprint;
  /** sha256 of the source computed during transfer, saved with the committed phase. */
  sourceHash?: string;
  /** Saved before each session.write, cleared by the checkpoint that confirms it. */
  writing?: { offset: Size; length: number };
  /** Saved by recovery before it removes a temp, so a repeated recovery may rely on it. */
  cleanup?: { tempPath: ResourcePath; tempFingerprint: Fingerprint };
  /**
   * Saved right before session.commit, only for jobs with an archive source and for pack (S14).
   * After a lost commit answer it is the proof of what was meant to be published.
   */
  commitIntent?: { size: Size; sha256: string; tempFingerprint: Fingerprint };
}

export interface JobStore {
  create(job: OperationJob): Promise<void>;
  get(id: string): Promise<OperationJob | null>;
  /** A thread ID scopes the page to that agent; "*" selects agent jobs across threads. */
  list(filter: { states?: JobState[]; limit: number; threadId?: string }): Promise<OperationJob[]>;

  /** Apply the patch atomically if the job still has the expected state. */
  update(
    id: string,
    patch: Partial<Pick<OperationJob, "state" | "progress" | "currentItem" | "pendingConflict" | "items" | "error" | "updatedAt" | "awaitsOwner">>,
    expectState: JobState,
  ): Promise<boolean>;

  checkpoint(checkpoint: Checkpoint): Promise<void>;
  lastCheckpoint(jobId: string, itemIndex: number): Promise<Checkpoint | null>;
}

/** Queries used by the Commander server, separate from runner persistence. */
export interface AgentJobStore extends JobStore {
  hasOwnerApproval(id: string): boolean;
  approvalQueueSize(threadId: string): { thread: number; total: number };
  listUnknownPage(filter: {
    states: JobState[]; limit: number; threadId?: string; cursor?: string;
  }): Promise<{ jobs: OperationJob[]; nextCursor?: string }>;
}
