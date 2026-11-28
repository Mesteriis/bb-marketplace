import { expect, test } from "vitest";
import type { EndpointId } from "./model.ts";
import { parsePosix } from "./path.ts";
import { buildPlan } from "./planner.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const signal = new AbortController().signal;
const ARCHIVE = "archive:123e4567-e89b-42d3-a456-426614174000" as EndpointId;
const PRECOMPOSED = "café.txt";
const DECOMPOSED = "café.txt";

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

const collision = { code: "invalid_archive", reason: "name_collision", message: "Two archive entries would get the same name in the destination" };

test("A.txt and a.txt from an archive on a case-insensitive target are refused, even with overwrite", async () => {
  await expect(plan(["A.txt", "a.txt"], false)).rejects.toMatchObject(collision);
});

test("two spellings of one name (precomposed and decomposed é) collide on a case-insensitive target", async () => {
  await expect(plan([PRECOMPOSED, DECOMPOSED], false)).rejects.toMatchObject(collision);
});

test("NFC and NFD of one name collide on a case-SENSITIVE target too, with any policy", async () => {
  await expect(plan([PRECOMPOSED, DECOMPOSED], true)).rejects.toMatchObject(collision);
  await expect(plan([PRECOMPOSED, DECOMPOSED], true, "ask")).rejects.toMatchObject(collision);
});

test("A.txt and a.txt are two different files on a case-sensitive target", async () => {
  const result = await plan(["A.txt", "a.txt"], true);
  expect(result.items.map((i) => i.target!.path.segments.at(-1))).toEqual([{ t: "A.txt" }, { t: "a.txt" }]);
});

test("two files with one name picked from different directories land on one name and are refused", async () => {
  await expect(plan(["a/x.txt", "b/x.txt"], true)).rejects.toMatchObject(collision);
});

test("the same file name inside two picked directories is no collision: each keeps its directory", async () => {
  const archive = new FakeProvider(ARCHIVE);
  await archive.mkdir(parsePosix("/a"), signal);
  await archive.mkdir(parsePosix("/b"), signal);
  archive.put(parsePosix("/a/x.txt"), Uint8Array.of(1), "1");
  archive.put(parsePosix("/b/x.txt"), Uint8Array.of(1), "1");
  const target = new FakeProvider("host:dst", true);
  await target.mkdir(parsePosix("/out"), signal);
  const result = await buildPlan({
    kind: "copy", initiator: { kind: "owner" }, sources: ["a", "b"].map((n) => ({ endpoint: ARCHIVE, path: parsePosix("/" + n) })),
    targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: "ask", verify: "size",
  }, {
    provider: (id) => (id === ARCHIVE ? archive : target), now: () => new Date(), uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 8 }, protectedPathsFor: () => [],
  }, signal);
  expect(result.items.filter((i) => i.kind === "file").map((i) => i.target!.path.segments.map((s) => "t" in s ? s.t : "?").join("/")))
    .toEqual(["out/a/x.txt", "out/b/x.txt"]);
});

test("a plan that does not start from an archive keeps the old refusal text", async () => {
  const from = new FakeProvider("host:from");
  from.put(parsePosix("/A.txt"), Uint8Array.of(1), "1");
  from.put(parsePosix("/a.txt"), Uint8Array.of(1), "1");
  const to = new FakeProvider("host:dst", false);
  await to.mkdir(parsePosix("/out"), signal);
  await expect(buildPlan({
    kind: "copy", initiator: { kind: "owner" }, sources: ["A.txt", "a.txt"].map((n) => ({ endpoint: "host:from" as EndpointId, path: parsePosix("/" + n) })),
    targetDir: { endpoint: "host:dst", path: parsePosix("/out") }, newName: null, conflictPolicy: "overwrite", verify: "size",
  }, {
    provider: (id) => (id === "host:from" ? from : to), now: () => new Date(), uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 8 }, protectedPathsFor: () => [],
  }, signal)).rejects.toMatchObject({ code: "invalid_path", message: "Two items would write to the same target" });
});
