// The public request that asks a Chertog page to open a tile.
import { describe, expect, it } from "vitest";
import { OPEN_EVENT, OPEN_OUTCOMES, openRequestSchema } from "../../../src/core/wire/index.ts";

const thread = { kind: "thread", threadId: "thr_1", accepted: false, outcome: null };
const panel = { kind: "panel", ref: { provider: "bb-diff", params: { path: "a.md" } }, accepted: false, outcome: null };

describe("chertog.open.v1 request", () => {
  it("is named by the version", () => {
    expect(OPEN_EVENT).toBe("chertog.open.v1");
    expect(OPEN_OUTCOMES).toEqual(["opened", "focused", "refused", "not-shown", "unsupported", "invalid"]);
  });

  it("accepts a thread request and a panel request", () => {
    expect(openRequestSchema.safeParse(thread).success).toBe(true);
    expect(openRequestSchema.safeParse(panel).success).toBe(true);
  });

  it("refuses an empty or oversized thread id and extra fields", () => {
    expect(openRequestSchema.safeParse({ ...thread, threadId: "" }).success).toBe(false);
    expect(openRequestSchema.safeParse({ ...thread, threadId: "x".repeat(201) }).success).toBe(false);
    expect(openRequestSchema.safeParse({ ...thread, url: "https://x" }).success).toBe(false);
    expect(openRequestSchema.safeParse({ ...panel, extra: 1 }).success).toBe(false);
  });

  it("refuses a panel reference that carries a secret or an unknown kind", () => {
    expect(openRequestSchema.safeParse({ ...panel, ref: { provider: "bb-diff", params: { apiToken: "x" } } }).success).toBe(false);
    expect(openRequestSchema.safeParse({ ...thread, kind: "file" }).success).toBe(false);
  });

  it("takes only a request the sender has not answered", () => {
    expect(openRequestSchema.safeParse({ ...thread, accepted: true }).success).toBe(false);
    expect(openRequestSchema.safeParse({ ...thread, outcome: "opened" }).success).toBe(false);
  });
});
