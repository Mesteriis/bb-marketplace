import { afterEach, expect, test, vi } from "vitest";
import { createPasswordGate } from "./archive-password.ts";

afterEach(() => vi.useRealTimers());
const ID = "123e4567-e89b-42d3-a456-426614174000";

test("asks the owner through publish and resolves with the typed bytes", async () => {
  const publish = vi.fn();
  const gate = createPasswordGate({ publish, timeoutMs: 1000 });
  const asking = gate.ask(ID);
  expect(publish).toHaveBeenCalledWith(ID);
  expect(gate.pending(ID)).toBe(true);
  expect(gate.provide(ID, "pässword")).toBe("accepted");
  expect([...(await asking)!]).toEqual([...new TextEncoder().encode("pässword")]);
  expect(gate.pending(ID)).toBe(false);
});

test("a password nobody asked for is refused and not kept", () => {
  const gate = createPasswordGate({ publish: vi.fn(), timeoutMs: 1000 });
  expect(gate.provide(ID, "x")).toBe("none_pending");
  expect(gate.pending(ID)).toBe(false);
});

test("cancel by the owner or silence resolves null", async () => {
  vi.useFakeTimers();
  const gate = createPasswordGate({ publish: vi.fn(), timeoutMs: 1000 });
  const first = gate.ask(ID);
  gate.cancel(ID);
  expect(await first).toBeNull();
  const second = gate.ask(ID);
  vi.advanceTimersByTime(1001);
  expect(await second).toBeNull();
  expect(gate.pending(ID)).toBe(false);
});

test("two questions about one archive at once are a programming error", async () => {
  const gate = createPasswordGate({ publish: vi.fn(), timeoutMs: 1000 });
  void gate.ask(ID);
  await expect(gate.ask(ID)).rejects.toMatchObject({ code: "internal" });
  gate.cancel(ID);
});

test("an empty password counts as no answer", async () => {
  const gate = createPasswordGate({ publish: vi.fn(), timeoutMs: 1000 });
  const asking = gate.ask(ID);
  expect(gate.provide(ID, "")).toBe("none_pending");
  gate.cancel(ID);
  expect(await asking).toBeNull();
});
