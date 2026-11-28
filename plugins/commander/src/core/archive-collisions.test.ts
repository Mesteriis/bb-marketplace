import { expect, test } from "vitest";
import type { EndpointId } from "./model.ts";
import { parsePosix } from "./path.ts";
import { buildPlan } from "./planner.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const signal = new AbortController().signal;
const ARCHIVE = "archive:123e4567-e89b-42d3-a456-426614174000" as EndpointId;

async function plan(names: string[], caseSensitiveTarget: boolean, policy: "ask" | "overwrite" = "overwrite") {
  const archive = new FakeProvider(ARCHIVE);
  for (const name of names) archive.put(parsePosix("/" + name), Uint8Array.of(1), "1");
  const target = new FakeProvider("host:dst", caseSensitiveTarget);
  await target.mkdir(parsePosix("/out"), signal);
  return buildPlan({
    kind: "copy", initiator: { kind: "owner" }, sources: names.map((name) => ({ endpoint: ARCHIVE, path: parsePosix("/" + name) })),
    targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: policy, verify: "size",
  }, {
    provider: (id) => (id === ARCHIVE ? archive : target), now: () => new Date(), uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 8 }, protectedPathsFor: () => [],
  }, signal);
}

test("A.txt and a.txt from an archive on a case-insensitive target are refused, even with overwrite", async () => {
  await expect(plan(["A.txt", "a.txt"], false)).rejects.toMatchObject({ code: "invalid_path" });
});

test("two spellings of one name (precomposed and decomposed é) collide on a case-insensitive target", async () => {
  await expect(plan(["café.txt", "café.txt"], false)).rejects.toMatchObject({ code: "invalid_path" });
});

test("the same names are two different files on a case-sensitive target", async () => {
  const result = await plan(["A.txt", "a.txt"], true);
  expect(result.items.map((i) => i.target!.path.segments.at(-1))).toEqual([{ t: "A.txt" }, { t: "a.txt" }]);
});
