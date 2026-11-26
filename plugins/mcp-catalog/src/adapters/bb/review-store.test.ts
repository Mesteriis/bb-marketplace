import { describe, expect, it } from "vitest";
import { KvReviewStore, type Kv } from "./review-store";

function memoryKv(): Kv {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, JSON.parse(JSON.stringify(value))),
    list: async (prefix = "") => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}

describe("KvReviewStore", () => {
  it("round-trips a record and replaces it by name and version", async () => {
    const store = new KvReviewStore(memoryKv());
    await store.put({ name: "io.example/Demo", version: "1.0.0", threadId: "t", state: "reviewing", startedAt: 5 });
    await store.put({ name: "io.example/Demo", version: "1.0.0", threadId: "t", state: "ready", worktree: "/wt" });
    expect(await store.list()).toEqual([
      { name: "io.example/Demo", version: "1.0.0", threadId: "t", state: "ready", worktree: "/wt" },
    ]);
  });

  it("skips a damaged record", async () => {
    const kv = memoryKv();
    await kv.set("review:bad", { nope: true });
    expect(await new KvReviewStore(kv).list()).toEqual([]);
  });

  it("keeps one record per name and version", async () => {
    const store = new KvReviewStore(memoryKv());
    await store.put({ name: "a/b", version: "1.0.0", threadId: "t1", state: "accepted", acceptCommit: "c" });
    await store.put({ name: "a/b", version: "2.0.0", threadId: "t2", state: "reviewing" });
    expect((await store.list()).map((rec) => [rec.version, rec.state]).sort()).toEqual([
      ["1.0.0", "accepted"],
      ["2.0.0", "reviewing"],
    ]);
  });

  it("still reads a record an earlier version stored under the bare name, and the new key wins over it", async () => {
    const kv = memoryKv();
    await kv.set("review:a/b", { name: "a/b", version: "1.0.0", threadId: "old", state: "reviewing" });
    const store = new KvReviewStore(kv);
    expect(await store.list()).toEqual([{ name: "a/b", version: "1.0.0", threadId: "old", state: "reviewing" }]);
    await store.put({ name: "a/b", version: "1.0.0", threadId: "old", state: "ready" });
    await store.put({ name: "a/b", version: "2.0.0", threadId: "new", state: "reviewing" });
    expect((await store.list()).map((rec) => [rec.version, rec.state]).sort()).toEqual([
      ["1.0.0", "ready"],
      ["2.0.0", "reviewing"],
    ]);
  });
});
