import { expectTypeOf, test } from "vitest";
import type { Checkpoint, JobStore } from "./job-store.ts";
import type { WriteSession } from "./provider.ts";
import type { ResourcePath } from "./path.ts";
import type { JobState, OperationJob } from "./model.ts";

test("JobStore exposes a state CAS and the last checkpoint for one item", () => {
  expectTypeOf<JobStore["update"]>().parameters.toEqualTypeOf<[
    string,
    Partial<Pick<OperationJob, "state" | "progress" | "currentItem" | "pendingConflict" | "items" | "error" | "updatedAt" | "awaitsOwner">>,
    JobState,
  ]>();
  expectTypeOf<JobStore["update"]>().returns.toEqualTypeOf<Promise<boolean>>();
  expectTypeOf<JobStore["lastCheckpoint"]>().toEqualTypeOf<
    (jobId: string, itemIndex: number) => Promise<Checkpoint | null>
  >();
  expectTypeOf<Checkpoint>().toEqualTypeOf<{
    jobId: string;
    itemIndex: number;
    phase: "copying" | "committed" | "verified" | "source_removed";
    bytesDone: string;
    tempName: string | null;
  }>();
});

test("WriteSession exposes a stable temporary resource path", () => {
  expectTypeOf<Pick<WriteSession, "tempPath">>().toEqualTypeOf<{
    readonly tempPath: ResourcePath;
  }>();
});
