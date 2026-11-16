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
