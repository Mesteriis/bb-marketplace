import { expect, test } from "vitest";
import { CommanderError } from "./errors.ts";
import { buildPlan, revalidate, type PlanRequest, type PlannerDeps } from "./planner.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { parsePosix } from "./path.ts";
import type { EndpointId, ResourceRef } from "./model.ts";

const PLAN_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-11-27T00:00:00.000Z");

async function world(files: Array<[string, string]>, caseSensitive = true) {
  const provider = new FakeProvider("host:x", caseSensitive);
  await provider.mkdir(parsePosix("/src"), new AbortController().signal);
  for (const [path, bytes] of files) {
    provider.put(parsePosix(path), new TextEncoder().encode(bytes), "1000");
  }
  return provider;
}

function depsFor(provider: FakeProvider, maxItems = 100_000): PlannerDeps {
  return {
    provider: (id: EndpointId) => {
      if (id !== provider.endpoint.id) throw new Error("unknown endpoint " + id);
      return provider;
    },
    now: () => NOW,
    uuid: () => PLAN_ID,
    limits: { maxItems, maxDepth: 32 },
    protectedPathsFor: () => [],
  };
}

function ref(path: string): ResourceRef {
  return { endpoint: "host:x", path: parsePosix(path) };
}

function batch(sources: string[], pattern: NonNullable<PlanRequest["pattern"]>): PlanRequest {
  return {
    kind: "rename",
    initiator: { kind: "owner" },
    sources: sources.map(ref),
    targetDir: null,
    newName: null,
    conflictPolicy: "ask",
    verify: "size",
    pattern,
  };
}

function signal() {
  return new AbortController().signal;
}

test('batch "[N]_[C]" counter{1,1,3} on /src/a.txt and /src/b.txt plans two renames', async () => {
  const provider = await world([["/src/a.txt", "1"], ["/src/b.txt", "2"]]);
  const plan = await buildPlan(batch(["/src/a.txt", "/src/b.txt"], {
    template: "[N]_[C]", counter: { start: 1, step: 1, width: 3 },
  }), depsFor(provider), signal());
  expect(plan.kind).toBe("rename");
  expect(plan.items.map((item) => [item.source?.path.segments.at(-1), item.target?.path.segments.at(-1)])).toEqual([
    [{ t: "a.txt" }, { t: "a_001.txt" }],
    [{ t: "b.txt" }, { t: "b_002.txt" }],
  ]);
  expect(plan.items.map((item) => item.expectTarget)).toEqual(["absent", "absent"]);
  expect(plan.targetDir).toBeNull();
});

test('two sources mapping to "x.txt" refuse the plan with invalid_name', async () => {
  const provider = await world([["/src/a.txt", "1"], ["/src/b.txt", "2"]]);
  const pending = buildPlan(batch(["/src/a.txt", "/src/b.txt"], { template: "x" }), depsFor(provider), signal());
  await expect(pending).rejects.toMatchObject({ code: "invalid_name" });
});

test('a target that already exists outside the batch refuses the plan with already_exists', async () => {
  const provider = await world([["/src/a.txt", "1"], ["/src/x.txt", "9"]]);
  const pending = buildPlan(batch(["/src/a.txt"], { template: "x" }), depsFor(provider), signal());
  await expect(pending).rejects.toMatchObject({ code: "already_exists" });
});

test("a cycle of targets held by batch sources plans, and the target's expectation is its current fingerprint", async () => {
  const provider = await world([["/src/1.txt", "a"], ["/src/2.txt", "b"]]);
  const plan = await buildPlan(batch(["/src/1.txt", "/src/2.txt"], {
    template: "[C].[E]", counter: { start: 2, step: 1, width: 1 },
  }), depsFor(provider), signal());
  // 1.txt → 2.txt (held by 2.txt, which moves to 3.txt): the plan records 2.txt's current state.
  expect(plan.items[0].target?.path.segments.at(-1)).toEqual({ t: "2.txt" });
  expect(plan.items[0].expectTarget).toEqual({ size: "1", mtimeNs: "1000" });
  expect(plan.items[1].expectTarget).toBe("absent");
});

test("revalidate accepts that same cycle plan: the batch targets are not refused as landing on sources", async () => {
  const provider = await world([["/src/1.txt", "a"], ["/src/2.txt", "b"]]);
  const plan = await buildPlan(batch(["/src/1.txt", "/src/2.txt"], {
    template: "[C].[E]", counter: { start: 2, step: 1, width: 1 },
  }), depsFor(provider), signal());
  const result = await revalidate(plan, depsFor(provider), signal());
  expect(result).toEqual({ ok: true, plan });
});

test("a batch over the 10000 item limit is refused as limit_exceeded before any entry is read", async () => {
  // The refusal happens before the first stat, so the sources need not exist.
  const provider = await world([]);
  const sources = Array.from({ length: 10_001 }, (_, index) => `/src/f${index}.txt`);
  const pending = buildPlan(batch(sources, { template: "[N]_[C]", counter: { start: 1, step: 1, width: 5 } }),
    depsFor(provider), signal());
  await expect(pending).rejects.toMatchObject({ code: "limit_exceeded" });
});

test("a batch whose names all stay the same is refused as invalid_name", async () => {
  const provider = await world([["/src/a.txt", "1"]]);
  const pending = buildPlan(batch(["/src/a.txt"], { template: "[N].[E]" }), depsFor(provider), signal());
  await expect(pending).rejects.toBeInstanceOf(CommanderError);
  await expect(pending).rejects.toMatchObject({ code: "invalid_name" });
});

test("entries from two directories cannot share one batch", async () => {
  const provider = await world([["/src/a.txt", "1"]]);
  await provider.mkdir(parsePosix("/other"), signal());
  provider.put(parsePosix("/other/b.txt"), new Uint8Array([2]), "1000");
  const pending = buildPlan(batch(["/src/a.txt", "/other/b.txt"], { template: "[N]_[C]" }), depsFor(provider), signal());
  await expect(pending).rejects.toMatchObject({ code: "invalid_path" });
});
