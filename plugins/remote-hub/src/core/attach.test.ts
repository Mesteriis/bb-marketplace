import { describe, expect, it } from "vitest";
import { AttachTokens } from "./attach.ts";
import { Scrollback, SCROLLBACK_MAX_BYTES } from "./scrollback.ts";

const encoder = new TextEncoder();

describe("Scrollback", () => {
  it("is bounded at 1 MiB with literal sizes", () => {
    const sb = new Scrollback(SCROLLBACK_MAX_BYTES);
    sb.append(new Uint8Array(512 * 1024));
    sb.append(new Uint8Array(512 * 1024));
    expect(sb.size).toBe(1024 * 1024);
    sb.append(new Uint8Array(64 * 1024));
    expect(sb.size).toBe(1024 * 1024);
    expect(sb.snapshot().byteLength).toBe(1024 * 1024);
  });

  it("preserves order and drops oldest first", () => {
    const sb = new Scrollback(4);
    sb.append(new Uint8Array([1, 2, 3]));
    sb.append(new Uint8Array([4, 5]));
    expect(Array.from(sb.snapshot())).toEqual([2, 3, 4, 5]);
  });
});

describe("AttachTokens", () => {
  it("is single use", () => {
    let now = 0;
    const tokens = new AttachTokens(30_000, { now: () => now });
    const token = tokens.issue(7, "a".repeat(32));
    expect(tokens.consume(token)).toEqual({ sessionId: 7, generation: "a".repeat(32) });
    expect(tokens.consume(token)).toBeNull();
  });

  it("expires after the TTL", () => {
    let now = 0;
    const tokens = new AttachTokens(30_000, { now: () => now });
    const token = tokens.issue(7, "a".repeat(32));
    now = 30_001;
    expect(tokens.consume(token)).toBeNull();
  });

  it("rejects an unknown token", () => {
    const tokens = new AttachTokens(30_000);
    expect(tokens.consume("f".repeat(32))).toBeNull();
  });
});
  it("caps outstanding tokens per session at 8", () => {
    let now = 0;
    const tokens = new AttachTokens(30_000, { now: () => now });
    const generation = "a".repeat(32);
    for (let i = 0; i < 20; i++) {
      tokens.issue(1, generation);
      now += 1;
    }
    expect(tokens.size).toBe(8);
  });

  it("caps outstanding tokens globally at 256", () => {
    let now = 0;
    const tokens = new AttachTokens(30_000, { now: () => now });
    for (let i = 0; i < 300; i++) {
      tokens.issue(i % 100, (i % 7).toString(16).repeat(32));
      now += 1;
    }
    expect(tokens.size).toBe(256);
  });

  it("revokes every token of one generation", () => {
    const tokens = new AttachTokens(30_000);
    const g1 = "a".repeat(32);
    const g2 = "b".repeat(32);
    const t1 = tokens.issue(1, g1);
    const t2 = tokens.issue(2, g1);
    const t3 = tokens.issue(1, g2);
    tokens.revokeGeneration(g1);
    expect(tokens.consume(t1)).toBeNull();
    expect(tokens.consume(t2)).toBeNull();
    expect(tokens.consume(t3)).toEqual({ sessionId: 1, generation: g2 });
  });
