import { expect, it } from "vitest";
import { EndpointId, OperationJob, OperationPlan, planDigest } from "./model.ts";

const plan = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  kind: "mkdir",
  createdAt: "2026-11-27T00:00:00.000Z",
  initiator: { kind: "owner" },
  sourceEndpoint: null,
  targetEndpoint: "host:test",
  items: [{
    source: null,
    target: { endpoint: "host:test", path: { segments: [{ t: "Привет" }] } },
    kind: "dir",
    fingerprint: null,
  }],
  conflictPolicy: "ask",
  route: "same-endpoint",
  verify: "size",
  totalBytes: "0",
} satisfies Omit<OperationPlan, "digest">;

const digest = "fe0f1fba822b6fe1c5e4b62663cb7e47a1a50fe1ad42ce4b5f158b6f032bbc33";

it("accepts host and SFTP endpoint IDs", () => {
  expect(EndpointId.parse("host:host_qu7wvy3gxm")).toBe("host:host_qu7wvy3gxm");
  expect(EndpointId.parse("sftp:123e4567-e89b-42d3-a456-426614174000"))
    .toBe("sftp:123e4567-e89b-42d3-a456-426614174000");
});

it("rejects an SFTP ID containing a relative path", () => {
  expect(EndpointId.safeParse("sftp:../x").success).toBe(false);
});

it("accepts a complete plan and rejects extra fields at any level", () => {
  expect(OperationPlan.parse({ ...plan, digest })).toEqual({ ...plan, digest });
  expect(() => OperationPlan.parse({ ...plan, digest, extra: true })).toThrow();
  expect(() => OperationPlan.parse({
    ...plan,
    digest,
    items: [{ ...plan.items[0], extra: true }],
  })).toThrow();
});

it.each([0, 100_001])("rejects a plan with %i items", (count) => {
  expect(() => OperationPlan.parse({
    ...plan,
    digest,
    items: Array.from({ length: count }, () => plan.items[0]),
  })).toThrow();
});

it("hashes the canonical JSON independently of top-level and nested key order", async () => {
  expect(await planDigest(plan)).toBe(digest);
  expect(await planDigest({
    totalBytes: "0",
    verify: "size",
    route: "same-endpoint",
    conflictPolicy: "ask",
    items: [{
      kind: "dir",
      target: { path: { segments: [{ t: "Привет" }] }, endpoint: "host:test" },
      fingerprint: null,
      source: null,
    }],
    targetEndpoint: "host:test",
    sourceEndpoint: null,
    initiator: { kind: "owner" },
    createdAt: "2026-11-27T00:00:00.000Z",
    kind: "mkdir",
    id: "123e4567-e89b-42d3-a456-426614174000",
  })).toBe(digest);
});

it("validates a pending job and uses decimal strings for its progress", () => {
  const job = {
    id: "223e4567-e89b-42d3-a456-426614174000",
    plan: { ...plan, digest },
    state: "pending",
    progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "0" },
    currentItem: null,
    pendingConflict: null,
    awaitsOwner: false,
    items: [{ outcome: "pending", error: null }],
    error: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
  };
  expect(OperationJob.parse(job)).toEqual(job);
  expect(OperationJob.safeParse({
    ...job,
    progress: { ...job.progress, bytesTotal: 0 },
  }).success).toBe(false);
});

it("excludes the digest when rehashing a complete plan", async () => {
  const signedPlan = OperationPlan.parse({ ...plan, digest });
  expect(await planDigest(signedPlan)).toBe(digest);
});
