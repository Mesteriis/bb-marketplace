import { expect, test } from "vitest";
import { ScanRunner } from "./scan-job.ts";

test("records partial progress and the result of a completed scan", async () => {
  const runner = new ScanRunner(() => "scan");
  const job = runner.start({ kind: "search", initiator: { kind: "owner" }, endpoints: ["host:test"], bytesPlanned: 8n },
    async (ctx) => {
      ctx.progress({ items: 1, bytes: 3n });
      ctx.markPartial("entry limit");
      return ["a"];
    });
  expect(job.state).toBe("running");
  await runner.wait(job.id);
  expect(runner.get(job.id)).toMatchObject({ state: "done", partial: true, progress: { items: 1, bytes: 3n, bytesPlanned: 8n } });
  expect(runner.result(job.id)).toEqual(["a"]);
});

test("cancellation keeps the scan cancelled even if work returns successfully", async () => {
  const runner = new ScanRunner(() => "scan");
  let finish!: () => void;
  const work = new Promise<void>((resolve) => { finish = resolve; });
  const job = runner.start({ kind: "checksum", initiator: { kind: "owner" }, endpoints: ["host:test"] },
    async () => { await work; return "late result"; });
  await Promise.resolve();
  runner.cancel(job.id);
  finish();
  await runner.wait(job.id);
  expect(runner.get(job.id)).toMatchObject({ state: "cancelled", partial: true });
  expect(runner.result(job.id)).toBeNull();
});

test("changing a wildcard grant cancels active agent scans but keeps owner scans", async () => {
  const ids = ["agent-a", "agent-b", "owner"];
  const runner = new ScanRunner(() => ids.shift()!);
  const work = Promise.withResolvers<string>();
  const start = (initiator: { kind: "agent"; threadId: string } | { kind: "owner" }) =>
    runner.start({ kind: "compare", initiator, endpoints: ["host:test"] }, () => work.promise);
  const a = start({ kind: "agent", threadId: "thread-a" });
  const b = start({ kind: "agent", threadId: "thread-b" });
  const owner = start({ kind: "owner" });
  await Promise.resolve();
  runner.cancelAgent("*");
  work.resolve("finished");
  await Promise.all([a, b, owner].map(({ id }) => runner.wait(id)));
  expect([a, b, owner].map(({ id }) => runner.get(id)?.state)).toEqual(["cancelled", "cancelled", "done"]);
});
