import { mkdir, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { OperationJob, OperationPlan } from "../src/core/model.ts";
import { localStand, pauseAfterWrite, waitForJob, waitForPart } from "./s19b-fixture.ts";
import { windows } from "./host-fs/fixtures.ts";

async function startCopy(stand: Awaited<ReturnType<typeof localStand>>, conflictPolicy = "ask") {
  const { id, digest } = OperationPlan.parse(await stand.rpc("plan_create", { ...stand.request, conflictPolicy }));
  return OperationJob.parse(await stand.rpc("plan_run", { planId: id, digest })).id;
}

test.each([
  { leftover: "none", state: "cancelled" },
  { leftover: "staging", state: "unknown" },
  { leftover: "destination", state: "unknown" },
])("reconciles a cancelled local copy with $leftover left on disk", async ({ leftover, state }) => {
  const { openStage, release } = pauseAfterWrite();
  const stand = await localStand({
    openStage,
    ...(leftover === "staging" ? { unlink: async () => { throw new Error("Cannot unlink staging"); }, onOrphan: () => {} } : {}),
  });
  try {
    const jobId = await startCopy(stand);
    const names = await waitForPart(stand.out, 3);
    if (leftover === "destination") await writeFile(join(stand.out, "a.txt"), "external");
    const cancellation = stand.rpc("job_cancel", { jobId });
    try { await waitForJob(stand.rpc, jobId, { state: "cancel_requested" }); }
    finally { release(); await cancellation; }
    await waitForJob(stand.rpc, jobId, { state, ...(state === "unknown" ? { error: { code: "outcome_unknown" } } : {}) });
    const expected = leftover === "staging" ? names : leftover === "destination" ? ["a.txt"] : [];
    expect(await readdir(stand.out)).toEqual(expected);
    if (leftover === "destination") expect(await readFile(join(stand.out, "a.txt"), "utf8")).toBe("external");
  } finally {
    release();
    await stand.close();
  }
});

test.skipIf(windows)("prepares HOME through an ancestor symlink and refuses traversal below HOME", async () => {
  const stand = await localStand();
  try {
    await mkdir(join(stand.root, "home"));
    await symlink(stand.root, join(stand.root, "alias"));
    await symlink(stand.out, join(stand.root, "home", "escape"));
    vi.stubEnv("HOME", join(stand.root, "alias", "home"));
    await expect(stand.rpc("endpoint_home", { endpoint: "host:test" })).resolves.toEqual({ path: stand.ref("home").path });
    await expect(stand.rpc("dir_list", { ref: stand.ref("home/escape/inside"), cursor: null, limit: 10 }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Symbolic link in directory path") });
  } finally {
    vi.unstubAllEnvs();
    await stand.close();
  }
});

test.skipIf(windows)("preserves the host error when HOME cannot be resolved", async () => {
  const stand = await localStand();
  try {
    await symlink("loop", join(stand.root, "loop"));
    vi.stubEnv("HOME", join(stand.root, "loop", "home"));
    await expect(stand.rpc("endpoint_home", { endpoint: "host:test" }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("permission_denied") });
  } finally {
    vi.unstubAllEnvs();
    await stand.close();
  }
});

test("fails the job cleanly when a staged write hits ENOSPC", async () => {
  const stand = await localStand({
    openStage: async (...args) => {
      const file = await open(...args);
      const write = file.write.bind(file);
      file.write = async () => {
        await write("a", 0);
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      };
      return file;
    },
  });
  try {
    await writeFile(join(stand.out, "a.txt"), "original");
    const jobId = await startCopy(stand, "overwrite");
    await waitForJob(stand.rpc, jobId, { state: "failed", error: { code: "no_space", message: "Not enough space on the destination filesystem" } });
    expect(await readdir(stand.out)).toEqual(["a.txt"]);
    expect(await readFile(join(stand.out, "a.txt"), "utf8")).toBe("original");
    expect(await readFile(join(stand.root, "a.txt"), "utf8")).toBe("abc");
  } finally {
    await stand.close();
  }
});

test("disposal interrupts a staged copy and the next activation recovers the same job from SQLite", async () => {
  const { openStage, release } = pauseAfterWrite();
  const stand = await localStand({ openStage });
  try {
    const jobId = await startCopy(stand);
    await waitForPart(stand.out, 3);
    const disabled = stand.disable();
    try { await vi.waitFor(() => expect(stand.workerSignal.aborted).toBe(true)); }
    finally { release(); await disabled; }
    expect(await readdir(stand.out)).toEqual([]);
    expect(stand.savedState(jobId)).toEqual({ state: "interrupted" });
    expect(stand.checkpoint(jobId)).toEqual([{ phase: "prepared", via: "copy" }]);

    stand.enable();
    await waitForJob(stand.rpc, jobId, { id: jobId, state: "completed", progress: { bytesDone: "3" } });
    expect(await readdir(stand.out)).toEqual(["a.txt"]);
    expect(await readFile(join(stand.out, "a.txt"), "utf8")).toBe("abc");
  } finally {
    release();
    await stand.close();
  }
});

test("a cancellation before staging cannot certify an existing target", async () => {
  const start = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stand = await localStand({ openStage: async () => { throw new Error("Unexpected staging"); } }, {
    beforeCopy: () => { start.resolve(); return release.promise; },
  });
  try {
    await writeFile(join(stand.out, "a.txt"), "original");
    const jobId = await startCopy(stand, "overwrite");
    await start.promise;
    const cancellation = stand.rpc("job_cancel", { jobId });
    try { await waitForJob(stand.rpc, jobId, { state: "cancel_requested" }); }
    finally { release.resolve(); await cancellation; }
    await waitForJob(stand.rpc, jobId, { state: "unknown", error: { code: "outcome_unknown" } });
    expect(await readdir(stand.out)).toEqual(["a.txt"]);
    expect(await readFile(join(stand.out, "a.txt"), "utf8")).toBe("original");
  } finally {
    release.resolve();
    await stand.close();
  }
});

test("an early transport abort waits for the worker to confirm staging cleanup", async () => {
  const { openStage, release } = pauseAfterWrite();
  const receipt = Promise.withResolvers<void>();
  const stand = await localStand({ openStage }, { earlyAbort: true, onReceipt: receipt.resolve });
  try {
    const jobId = await startCopy(stand);
    await waitForPart(stand.out, 3);
    const cancellation = stand.rpc("job_cancel", { jobId });
    try { await receipt.promise; }
    finally { release(); await cancellation; }
    await waitForJob(stand.rpc, jobId, { state: "cancelled" });
    expect(await readdir(stand.out)).toEqual([]);
  } finally {
    release();
    await stand.close();
  }
});

test.each([
  { appeared: false, state: "completed", contents: "abc" },
  { appeared: true, state: "unknown", contents: "external" },
])("checks the checkpoint when preparing a replacement worker and the target appeared=$appeared", async ({ appeared, state, contents }) => {
  const { openStage, release } = pauseAfterWrite();
  const stand = await localStand({ openStage });
  try {
    const jobId = await startCopy(stand);
    await waitForPart(stand.out, 3);
    const stopped = stand.stopWorker();
    try { expect(stand.workerSignal.aborted).toBe(true); }
    finally { release(); await stopped; }
    await waitForJob(stand.rpc, jobId, { state: "interrupted" });
    stand.replaceWorker();
    if (appeared) await writeFile(join(stand.out, "a.txt"), "external");
    await stand.rpc("endpoint_home", { endpoint: "host:test" });
    await waitForJob(stand.rpc, jobId, { id: jobId, state });
    expect(await readdir(stand.out)).toEqual(["a.txt"]);
    expect(await readFile(join(stand.out, "a.txt"), "utf8")).toBe(contents);
  } finally {
    release();
    await stand.close();
  }
});
