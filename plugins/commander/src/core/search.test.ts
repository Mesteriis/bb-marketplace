import { expect, it } from "vitest";
import { buildPlan } from "./planner.ts";
import { compileName } from "./glob.ts";
import { search, type SearchQuery } from "./search.ts";
import { displayPath, parsePosix } from "./path.ts";
import { ScanRunner } from "./scan-job.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const signal = new AbortController().signal;
const owner = { kind: "owner" } as const;
const uuid = () => "00000000-0000-4000-8000-000000000001";
const bytes = new TextEncoder();
const query = (provider: FakeProvider): SearchQuery => ({
  root: { endpoint: provider.endpoint.id, path: parsePosix("/") },
  limits: { maxDepth: 32, maxEntries: 100_000, maxBytesRead: 0n },
});

it('glob "*.TXT" matches "a.txt" only on a case-insensitive endpoint', () => {
  expect(compileName({ glob: "*.TXT" }, false)("a.txt")).toBe(true);
  expect(compileName({ glob: "*.TXT" }, true)("a.txt")).toBe(false);
});

it('refuses nested quantifiers before matching 50 a characters followed by !', () => {
  expect(() => compileName({ regex: "(a+)+$" }, true)("a".repeat(50) + "!"))
    .toThrow("Unsafe search regex");
});

it("refuses SFTP content search before listing or reading without consent", async () => {
  const provider = new FakeProvider("sftp:test");
  const input = { ...query(provider), content: { text: "needle", caseSensitive: true } };
  await expect(search(input, () => provider, { signal, progress() {}, markPartial() {} })[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ code: "content_search_needs_consent" });
  expect(provider.calls).toEqual([]);
});

it("returns 3 hits out of 5 SFTP files and marks the scan partial", async () => {
  const provider = new FakeProvider("sftp:test");
  for (const name of ["a", "b", "c", "d", "e"]) provider.put(parsePosix("/" + name), bytes.encode(name));
  const input = query(provider);
  input.limits.maxEntries = 3;
  const scans = new ScanRunner(uuid);
  const job = scans.start({ kind: "search", initiator: owner, endpoints: ["sftp:test"] }, async (ctx) => {
    const hits = [];
    for await (const hit of search(input, () => provider, ctx)) hits.push(displayPath(hit.ref.path));
    return hits;
  });
  await scans.wait(job.id);
  expect(scans.result(job.id)).toEqual(["/a", "/b", "/c"]);
  expect(scans.get(job.id)).toMatchObject({ state: "done", partial: true, progress: { items: 3 } });
});

it("cancellation stops listing within the in-flight page", async () => {
  const provider = new FakeProvider("sftp:test");
  const controller = new AbortController();
  let requests = 0;
  provider.list = async () => {
    requests++;
    controller.abort();
    return { entries: [], cursor: "next" };
  };
  const hits = search(query(provider), () => provider, { signal: controller.signal, progress() {}, markPartial() {} });
  await expect(hits[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});

it("plans one copy with two items from different search directories", async () => {
  const provider = new FakeProvider("host:test");
  for (const path of ["/one", "/two", "/target"]) await provider.mkdir(parsePosix(path), signal);
  provider.put(parsePosix("/one/a.txt"), bytes.encode("a"));
  provider.put(parsePosix("/two/b.txt"), bytes.encode("b"));
  const root = { endpoint: "host:test", path: parsePosix("/target") };
  const sources = [];
  for await (const hit of search({ ...query(provider), name: { glob: "*.txt" } }, () => provider,
    { signal, progress() {}, markPartial() {} })) sources.push(hit.ref);
  const plan = await buildPlan({
    kind: "copy", sources, targetDir: root, initiator: owner, conflictPolicy: "ask", verify: "size", newName: null,
  }, { provider: () => provider, uuid, now: () => new Date("2026-11-27"), limits: { maxDepth: 32, maxItems: 10 },
    protectedPathsFor: () => [] }, signal);
  expect(plan.items.map(({ source, target }) => [displayPath(source!.path), displayPath(target!.path)]))
    .toEqual([["/one/a.txt", "/target/a.txt"], ["/two/b.txt", "/target/b.txt"]]);
});
