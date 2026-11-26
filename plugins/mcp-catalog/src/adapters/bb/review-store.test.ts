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
  it("round-trips a record and replaces it by name", async () => {
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
});
