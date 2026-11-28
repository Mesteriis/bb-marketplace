import { describe, expect, it } from "vitest";
import { EndpointId, Entry, Fingerprint, OperationJob, OperationPlan, planDigest } from "./model.ts";

const plan = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  kind: "mkdir",
  createdAt: "2026-11-27T00:00:00.000Z",
  initiator: { kind: "owner" },
  sourceEndpoint: null,
  targetEndpoint: "host:test",
  targetDir: { endpoint: "host:test", path: { segments: [] } },
  items: [{
    source: null,
    target: { endpoint: "host:test", path: { segments: [{ t: "Привет" }] } },
    kind: "dir",
    fingerprint: null,
    expectTarget: "absent",
  }],
  conflictPolicy: "ask",
  route: "same-endpoint",
  verify: "size",
  totalBytes: "0",
} satisfies Omit<OperationPlan, "digest">;

// Recomputed with an independent canonical hash (sorted keys) after targetDir and expectTarget were added.
const digest = "204af016dbd3b54a5992205737c80f46dcc4d79a75d30e390218b28f4766dc04";

it("accepts host and SFTP endpoint IDs", () => {
  expect(EndpointId.parse("host:host_qu7wvy3gxm")).toBe("host:host_qu7wvy3gxm");
  expect(EndpointId.parse("sftp:123e4567-e89b-42d3-a456-426614174000"))
    .toBe("sftp:123e4567-e89b-42d3-a456-426614174000");
});

it("accepts an archive endpoint ID and rejects malformed ones", () => {
  expect(EndpointId.parse("archive:123e4567-e89b-42d3-a456-426614174000"))
    .toBe("archive:123e4567-e89b-42d3-a456-426614174000");
  for (const bad of ["archive:../x", "archive:", "archive:123e4567", "archive:123E4567-E89B-42D3-A456-426614174000"]) {
    expect(EndpointId.safeParse(bad).success, bad).toBe(false);
  }
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
    targetDir: { path: { segments: [] }, endpoint: "host:test" },
    items: [{
      kind: "dir",
      expectTarget: "absent",
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
} satisfies OperationJob;

it("validates a pending job and uses decimal strings for its progress", () => {
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

it("rejects an endpoint UUID made entirely of hyphens", () => {
  expect(EndpointId.safeParse("sftp:------------------------------------").success).toBe(false);
});

const entry = {
  name: { t: "link" },
  kind: "symlink",
  size: "0",
  mtimeNs: "0",
  mtimePrecision: "ns",
  mode: null,
  linkTarget: null,
  hidden: false,
};

it.each(["-0", "007", "-007"])("rejects noncanonical mtimeNs %j", (mtimeNs) => {
  expect(Entry.safeParse({ ...entry, mtimeNs }).success).toBe(false);
  expect(Fingerprint.safeParse({ size: "0", mtimeNs }).success).toBe(false);
});

it("accepts zero and negative timestamps in canonical form", () => {
  expect(Entry.parse(entry).mtimeNs).toBe("0");
  expect(Fingerprint.parse({ size: "0", mtimeNs: "-1" }).mtimeNs).toBe("-1");
});

it("preserves relative link targets as text or raw bytes", () => {
  expect(Entry.parse({ ...entry, linkTarget: { t: "../target" } }).linkTarget)
    .toEqual({ t: "../target" });
  expect(Entry.parse({ ...entry, linkTarget: { b: "Li4v/w==" } }).linkTarget)
    .toEqual({ b: "Li4v/w==" });
  expect(Entry.safeParse({ ...entry, linkTarget: { b: "/x==" } }).success).toBe(false);
});

it("ignores extra fields when hashing the plan", async () => {
  const annotated = { ...plan, label: "fixture annotation" };
  expect(await planDigest(annotated)).toBe(digest);
});

const conflict = {
  id: "323e4567-e89b-42d3-a456-426614174000",
  jobId: "223e4567-e89b-42d3-a456-426614174000",
  itemIndex: 0,
  reason: "exists",
  source: null,
  target: null,
} satisfies NonNullable<OperationJob["pendingConflict"]>;

it.each([
  ["job item count", { items: [] }, ["items"]],
  ["finished item count", { progress: { ...job.progress, itemsDone: 2 } }, ["progress", "itemsDone"]],
  ["transferred bytes", { progress: { ...job.progress, bytesDone: "9007199254740993", bytesTotal: "9007199254740992" } }, ["progress", "bytesDone"]],
  ["owner approval", { state: "running", awaitsOwner: true }, ["awaitsOwner"]],
  ["conflict", { pendingConflict: conflict }, ["pendingConflict"]],
  ["current item", { currentItem: 1 }, ["currentItem"]],
] as const)("rejects a job with invalid %s", (_name, patch, path) => {
  const result = OperationJob.safeParse({ ...job, ...patch });
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path);
});

it("accepts pending jobs waiting for owner approval", () => {
  const pending = { ...job, awaitsOwner: true };
  expect(OperationJob.parse(pending)).toEqual(pending);
});

it("accepts an unknown job with an unknown item outcome", () => {
  const unknown = { ...job, state: "unknown", items: [{ outcome: "unknown", error: null }] };
  expect(OperationJob.parse(unknown)).toEqual(unknown);
});

it("accepts a conflict for an awaiting-decision job", () => {
  const awaiting = { ...job, state: "awaiting_decision", pendingConflict: conflict, currentItem: 0 };
  expect(OperationJob.parse(awaiting)).toEqual(awaiting);
});

describe("OperationPlan targetDir rules", () => {
  const copyItem = {
    source: { endpoint: "host:test", path: { segments: [{ t: "src" }] } },
    target: { endpoint: "host:test", path: { segments: [{ t: "out" }, { t: "src" }] } },
    kind: "dir",
    fingerprint: { size: "0", mtimeNs: "1000000000" },
    expectTarget: "absent",
  } as const;
  const copyPlan = {
    ...plan,
    digest,
    kind: "copy",
    sourceEndpoint: "host:test",
    targetDir: { endpoint: "host:test", path: { segments: [{ t: "out" }] } },
    items: [copyItem],
  } as const;

  it("accepts a copy whose targetDir matches its target endpoint and contains its targets", () => {
    expect(OperationPlan.safeParse(copyPlan).success).toBe(true);
  });

  it("refuses mkdir without a targetDir", () => {
    expect(OperationPlan.safeParse({ ...plan, digest, targetDir: null }).success).toBe(false);
  });

  it("refuses copy without a targetDir", () => {
    expect(OperationPlan.safeParse({ ...copyPlan, targetDir: null }).success).toBe(false);
  });

  it("refuses move without a targetDir", () => {
    expect(OperationPlan.safeParse({ ...copyPlan, kind: "move", targetDir: null }).success).toBe(false);
  });

  it("refuses delete with a targetDir", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      kind: "delete",
      targetEndpoint: null,
      items: [{ ...copyItem, target: null, expectTarget: null }],
    }).success).toBe(false);
  });

  it("refuses rename with a targetDir", () => {
    expect(OperationPlan.safeParse({ ...copyPlan, kind: "rename", targetEndpoint: "host:test" }).success).toBe(false);
  });

  it("refuses a targetDir on another endpoint than targetEndpoint", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      targetDir: { endpoint: "host:other", path: { segments: [{ t: "out" }] } },
    }).success).toBe(false);
  });

  it("refuses an item target that is not under targetDir", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      targetDir: { endpoint: "host:test", path: { segments: [{ t: "elsewhere" }] } },
    }).success).toBe(false);
  });
});

describe("OperationPlan item targets for copy, move and mkdir", () => {
  const item = {
    source: { endpoint: "host:test", path: { segments: [{ t: "src" }] } },
    target: { endpoint: "host:test", path: { segments: [{ t: "out" }, { t: "src" }] } },
    kind: "dir",
    fingerprint: { size: "0", mtimeNs: "1000000000" },
    expectTarget: "absent",
  } as const;
  const copyPlan = {
    ...plan,
    digest,
    kind: "copy",
    sourceEndpoint: "host:test",
    targetDir: { endpoint: "host:test", path: { segments: [{ t: "out" }] } },
    items: [item],
  } as const;

  it("refuses a copy whose item target is on another endpoint", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      items: [{ ...item, target: { ...item.target, endpoint: "host:other" } }],
    }).success).toBe(false);
  });

  it("refuses a copy whose item target equals targetDir", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      items: [{ ...item, target: { endpoint: "host:test", path: { segments: [{ t: "out" }] } } }],
    }).success).toBe(false);
  });

  it("refuses a copy whose item has no target", () => {
    expect(OperationPlan.safeParse({
      ...copyPlan,
      items: [{ ...item, target: null, expectTarget: null }],
    }).success).toBe(false);
  });
});

describe("S13 synchronization identity", () => {
  const syncId = "123e4567-e89b-42d3-a456-426614174001";

  it("accepts the existing stage 1 fixture and retains its literal digest", async () => {
    const legacy = OperationPlan.parse({ ...plan, digest });
    expect(legacy).not.toHaveProperty("syncId");
    expect(await planDigest(legacy)).toBe("204af016dbd3b54a5992205737c80f46dcc4d79a75d30e390218b28f4766dc04");
  });

  it("binds syncId to the signed plan", async () => {
    const signed = OperationPlan.parse({ ...plan, syncId, digest: "c87cd1024b739b1381dbf5e0cfac7c4c2b59a48995a7d02910009450cf1a28d7" });
    expect(await planDigest(signed)).toBe(signed.digest);
    const tampered = { ...signed, syncId: "123e4567-e89b-42d3-a456-426614174002" };
    expect(await planDigest(tampered)).toBe("393731e47dbeb4a12cdbe279ef7e3171256659c6afe0be9ce508a5349c1bb73b");
  });
});
