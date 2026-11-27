import { expect, test } from "vitest";
import type { OperationJob } from "../model.ts";
import { MemoryJobStore } from "./memory-job-store.ts";

const date = "2026-11-27T00:00:00.000Z";
const job: OperationJob = {
  id: "223e4567-e89b-42d3-a456-426614174000",
  plan: {
    id: "123e4567-e89b-42d3-a456-426614174000",
    kind: "mkdir",
    createdAt: date,
    initiator: { kind: "owner" },
    sourceEndpoint: null,
    targetEndpoint: "host:test",
    targetDir: { endpoint: "host:test", path: { segments: [] } },
    items: [{
      source: null,
      target: { endpoint: "host:test", path: { segments: [{ t: "folder" }] } },
      kind: "dir",
      fingerprint: null,
      expectTarget: "absent",
    }],
    conflictPolicy: "ask",
    route: "same-endpoint",
    verify: "size",
    totalBytes: "0",
    digest: "a".repeat(64),
  },
  state: "pending",
  awaitsOwner: true,
  currentItem: null,
  pendingConflict: null,
  progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "0" },
  items: [{ outcome: "pending", error: null }],
  error: null,
  createdAt: date,
  updatedAt: date,
};

test.each(["running", "cancel_requested"] as const)("leaves pending for %s with approval cleared atomically", async (state) => {
  const store = new MemoryJobStore();
  await store.create(job);

  expect(await store.get(job.id)).toMatchObject({ state: "pending", awaitsOwner: true });
  expect(await store.update(job.id, { state }, "pending")).toBe(true);
  expect(await store.get(job.id)).toMatchObject({ state, awaitsOwner: false });

  expect(await store.update(job.id, { state: "cancelled" }, "pending")).toBe(false);
  expect(await store.get(job.id)).toMatchObject({ state, awaitsOwner: false });
});
