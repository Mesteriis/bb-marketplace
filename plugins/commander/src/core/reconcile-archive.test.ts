import { describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "./job-store.ts";
import type { Fingerprint, OperationPlan, PlanItem } from "./model.ts";
import { parsePosix, type ResourcePath } from "./path.ts";
import { reconcileItem, tempNameFor, type Location } from "./reconcile.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

// SHA-256 of "abc" (FIPS 180-2 test vector) and of "abd".
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const JOB = "223e4567-e89b-42d3-a456-426614174000";
const bytes = (s: string) => new TextEncoder().encode(s);
const MTIME = "1732665600000000000";
const NEWER = "1732665700000000000";
const OLDER = "1732665500000000000";

const tempPath: ResourcePath = { segments: [{ t: "d" }, tempNameFor(JOB, 0)] };
const targetPath = parsePosix("/d/out.txt");
const intent = (over: Partial<NonNullable<Checkpoint["commitIntent"]>> = {}): NonNullable<Checkpoint["commitIntent"]> => ({
  size: "3", sha256: SHA_ABC, tempFingerprint: { size: "3", mtimeNs: MTIME }, ...over,
});

function setup(opts: {
  policy?: OperationPlan["conflictPolicy"];
  expectTarget?: Fingerprint | "absent";
  sourceMtime?: string;
  atomicReplace?: boolean;
  temp?: { bytes: string; mtime?: string } | null;
  target?: { bytes: string; mtime?: string } | null;
  commitIntent?: Checkpoint["commitIntent"] | null;
} = {}) {
  const archive = new FakeProvider("host:src");
  archive.put(parsePosix("/a.zip-entry"), bytes("abc"), opts.sourceMtime ?? MTIME);
  const provider = new FakeProvider("host:dst");
  if (opts.atomicReplace === false) (provider.capabilities as Set<string>).delete("atomicReplace");
  if (opts.temp !== null) provider.put(tempPath, bytes(opts.temp?.bytes ?? "abc"), opts.temp?.mtime ?? MTIME);
  if (opts.target) provider.put(targetPath, bytes(opts.target.bytes), opts.target.mtime ?? MTIME);
  const source: Location = { provider: archive, path: parsePosix("/a.zip-entry") };
  const target: Location = { provider, path: targetPath };
  const expectTarget = opts.expectTarget ?? "absent";
  const item: PlanItem = {
    source: { endpoint: "host:ffffffff", path: parsePosix("/a.zip-entry") },
    target: { endpoint: "host:eeeeeeee", path: targetPath },
    kind: "file",
    fingerprint: { size: "3", mtimeNs: opts.sourceMtime ?? MTIME },
    expectTarget,
  };
  const plan = { kind: "copy", conflictPolicy: opts.policy ?? "ask", verify: "size" } as unknown as OperationPlan;
  const checkpoint: Checkpoint = {
    jobId: JOB, itemIndex: 0, phase: "copying", bytesDone: "3", tempPath, tempFingerprint: { size: "3", mtimeNs: MTIME },
    targetPath, expectTarget, verified: null, ...(opts.commitIntent === null ? {} : { commitIntent: opts.commitIntent ?? intent() }),
  };
  const saved: Checkpoint[] = [];
  const rename = vi.spyOn(provider, "rename");
  const openWrite = vi.spyOn(provider, "openWrite");
  const run = () => reconcileItem(checkpoint, source, target, item, plan,
    { signal: new AbortController().signal, chunkBytes: 1024, call: (call) => call() }, async (c) => { saved.push(c); });
  return { run, provider, rename, openWrite, saved };
}

describe("a lost commit answer, proven by commitIntent", () => {
  it("is done when the temp is gone and the target holds the intended bytes (SHA-256 equal)", async () => {
    const s = setup({ temp: null, target: { bytes: "abc", mtime: NEWER } });
    expect(await s.run()).toBe("done");
    expect(s.rename).not.toHaveBeenCalled();
    expect(s.saved.at(-1)).toMatchObject({ phase: "verified", verified: { size: "3", sha256: SHA_ABC } });
  });
  it("is unknown for a target with the same size and mtime but other bytes", async () => {
    const s = setup({ temp: null, target: { bytes: "abd", mtime: MTIME } });
    await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(s.rename).not.toHaveBeenCalled();
  });
  it("is unknown when the target hash cannot be read", async () => {
    const s = setup({ temp: null, target: { bytes: "abc" } });
    vi.spyOn(s.provider, "read").mockRejectedValue(new Error("offline"));
    await expect(s.run()).rejects.toBeDefined();
    expect(s.rename).not.toHaveBeenCalled();
  });
});

describe("republishing a verified temp after a restart", () => {
  it("renames into an absent target with replace false and expectTarget absent, without openWrite", async () => {
    const s = setup();
    expect(await s.run()).toBe("done");
    expect(s.rename).toHaveBeenCalledTimes(1);
    expect(s.rename.mock.calls[0]?.[2]).toEqual({ replace: false, expectTarget: "absent" });
    expect(s.openWrite).not.toHaveBeenCalled();
    expect(s.provider.contents(targetPath)).toEqual(bytes("abc"));
    expect(s.provider.contents(tempPath)).toBeNull();
    expect(s.saved.at(-1)).toMatchObject({ phase: "verified", verified: { size: "3", sha256: SHA_ABC } });
  });
  it("does not need atomicReplace for an absent target", async () => {
    const s = setup({ atomicReplace: false });
    expect(await s.run()).toBe("done");
    expect(s.rename).toHaveBeenCalledTimes(1);
  });
  it("is unknown when the temp changed (other bytes, other fingerprint) and never renames", async () => {
    for (const temp of [{ bytes: "abd" }, { bytes: "abc", mtime: NEWER }]) {
      const s = setup({ temp });
      await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(s.rename).not.toHaveBeenCalled();
    }
  });
  it("is unknown when a target appeared that the plan did not expect", async () => {
    const s = setup({ target: { bytes: "xyz" } });
    await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(s.rename).not.toHaveBeenCalled();
  });
});

describe("republishing over an existing target needs a proven permission", () => {
  const existing = { size: "5", mtimeNs: OLDER };
  const prior = { bytes: "12345", mtime: OLDER };

  it("replaces under conflictPolicy overwrite on a provider with atomicReplace", async () => {
    const s = setup({ policy: "overwrite", expectTarget: existing, target: prior });
    expect(await s.run()).toBe("done");
    expect(s.rename.mock.calls[0]?.[2]).toEqual({ replace: true, expectTarget: existing });
    expect(s.provider.contents(targetPath)).toEqual(bytes("abc"));
  });
  it("replaces under overwriteIfNewer only when the saved source mtime is strictly newer than the target's", async () => {
    const ok = setup({ policy: "overwriteIfNewer", expectTarget: existing, target: prior, sourceMtime: NEWER });
    expect(await ok.run()).toBe("done");
    expect(ok.rename).toHaveBeenCalledTimes(1);
    for (const sourceMtime of [OLDER, "1732665400000000000"]) {
      const s = setup({ policy: "overwriteIfNewer", expectTarget: existing, target: prior, sourceMtime });
      await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(s.rename).not.toHaveBeenCalled();
    }
  });
  it("is unknown under overwriteIfNewer when a time is unknown", async () => {
    const s = setup({ policy: "overwriteIfNewer", expectTarget: { size: "5", mtimeNs: null }, target: { bytes: "12345" } });
    await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(s.rename).not.toHaveBeenCalled();
  });
  it("is unknown under ask, skip and rename: the owner's earlier choice is not stored", async () => {
    for (const policy of ["ask", "skip", "rename"] as const) {
      const s = setup({ policy, expectTarget: existing, target: prior });
      await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(s.rename).not.toHaveBeenCalled();
    }
  });
  it("is unknown without atomicReplace even when overwrite is allowed", async () => {
    const s = setup({ policy: "overwrite", expectTarget: existing, target: prior, atomicReplace: false });
    await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(s.rename).not.toHaveBeenCalled();
  });
  it("is unknown when the target no longer matches the expected version", async () => {
    const s = setup({ policy: "overwrite", expectTarget: existing, target: { bytes: "12345", mtime: NEWER } });
    await expect(s.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(s.rename).not.toHaveBeenCalled();
  });
});

describe("without commitIntent the old recovery is unchanged", () => {
  it("does not republish and does not claim a commit", async () => {
    const s = setup({ commitIntent: null });
    expect(await s.run()).toBe("pending");
    expect(s.rename).not.toHaveBeenCalled();
  });
});
