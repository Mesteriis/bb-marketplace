import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasteFallback } from "./paste-fallback.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createPasteFallback", () => {
  it("reads the clipboard itself when no paste event follows the shortcut within 150 ms", async () => {
    const deliver = vi.fn();
    const read = vi.fn(async () => "hello");
    const f = createPasteFallback(deliver, read);
    f.shortcut();
    await vi.advanceTimersByTimeAsync(149);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledWith("hello");
  });

  it("does not read when the browser's paste event came", async () => {
    const read = vi.fn(async () => "hello");
    const f = createPasteFallback(vi.fn(), read);
    f.shortcut();
    f.eventSeen();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).not.toHaveBeenCalled();
  });

  it("types nothing when the read is refused, when the clipboard is empty, or after the view is gone", async () => {
    const deliver = vi.fn();
    createPasteFallback(deliver, async () => Promise.reject(new Error("denied"))).shortcut();
    createPasteFallback(deliver, async () => "").shortcut();
    const late = createPasteFallback(deliver, async () => "late");
    late.shortcut();
    late.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(deliver).not.toHaveBeenCalled();
  });
});
