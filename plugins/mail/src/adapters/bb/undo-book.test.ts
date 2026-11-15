import { describe, expect, it } from "vitest";
import { FixedClock } from "../../core/testing/fakes.ts";
import { UNDO_TTL_MS, type UndoGroup } from "../../core/undo.ts";
import { RoundWakes, UndoBook } from "./undo-book.ts";

const T0 = new Date("2026-11-15T10:00:00.000Z");
const ID_A = "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a6b";
const ID_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const group = (accountId: string, ids: string[]): UndoGroup => ({
  accountId,
  source: "INBOX",
  destination: "Archive",
  destinationUse: "archive",
  ids,
});

function book() {
  const clock = new FixedClock(T0);
  return { clock, undo: new UndoBook(clock) };
}

describe("UndoBook", () => {
  it("records, merges chunks of one id, and a new id replaces the slot", () => {
    const { undo } = book();
    expect(undo.record(ID_A, "archive", [group("acc_1", ["m_1"])])).toBe(true);
    expect(undo.record(ID_A, "archive", [group("acc_2", ["m_2"])])).toBe(true);
    expect(undo.peek(ID_A)!.groups.map((g) => g.accountId)).toEqual(["acc_1", "acc_2"]);
    expect(undo.record(ID_B, "delete", [group("acc_1", ["m_3"])])).toBe(true);
    expect(undo.has(ID_A)).toBe(false);
    expect(undo.has(ID_B)).toBe(true);
  });

  it("a call that queued nothing records nothing and leaves the slot", () => {
    const { undo } = book();
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"])]);
    expect(undo.record(ID_B, "archive", [])).toBe(false);
    expect(undo.has(ID_A)).toBe(true);
  });

  it("take consumes a matching record once; a stale or foreign id takes nothing", () => {
    const { undo } = book();
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"])]);
    expect(undo.take(ID_B)).toBeNull();
    expect(undo.has(ID_A)).toBe(true);
    const taken = undo.take(ID_A);
    expect(taken!.groups[0]!.ids).toEqual(["m_1"]);
    expect(undo.take(ID_A)).toBeNull();
    expect(undo.has(ID_A)).toBe(false);
  });

  it("expires after the undo window", () => {
    const { clock, undo } = book();
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"])]);
    clock.set(new Date(T0.getTime() + UNDO_TTL_MS - 1));
    expect(undo.has(ID_A)).toBe(true);
    clock.set(new Date(T0.getTime() + UNDO_TTL_MS));
    expect(undo.has(ID_A)).toBe(false);
    expect(undo.peek(ID_A)).toBeNull();
    expect(undo.take(ID_A)).toBeNull();
  });

  it("putBack restores failed groups with the same id and expiry, merging two put-backs", () => {
    const { clock, undo } = book();
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"]), group("acc_2", ["m_2"])]);
    const taken = undo.take(ID_A)!;
    clock.set(new Date(T0.getTime() + 1000));
    expect(undo.putBack({ ...taken, groups: [taken.groups[0]!] })).toBe(true);
    expect(undo.putBack({ ...taken, groups: [taken.groups[1]!] })).toBe(true);
    const back = undo.peek(ID_A)!;
    expect(back.expiresAt).toBe(taken.expiresAt);
    expect(back.groups.map((g) => g.accountId)).toEqual(["acc_1", "acc_2"]);
  });

  it("putBack is refused once a newer record took the slot, or after expiry", () => {
    const { clock, undo } = book();
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"])]);
    const taken = undo.take(ID_A)!;
    undo.record(ID_B, "delete", [group("acc_1", ["m_9"])]);
    expect(undo.putBack(taken)).toBe(false);
    expect(undo.has(ID_B)).toBe(true);
    // Still refused after the newer record was consumed in turn.
    undo.take(ID_B);
    expect(undo.putBack(taken)).toBe(false);
    undo.record(ID_A, "archive", [group("acc_1", ["m_1"])]);
    const again = undo.take(ID_A)!;
    clock.set(new Date(T0.getTime() + UNDO_TTL_MS));
    expect(undo.putBack(again)).toBe(false);
    expect(undo.has(ID_A)).toBe(false);
  });
});

describe("RoundWakes", () => {
  it("wakes an account once after its next round ends, and only accounts that asked", () => {
    const woken: string[] = [];
    const wakes = new RoundWakes((accountId) => woken.push(accountId));
    wakes.roundEnded("acc_1");
    expect(woken).toEqual([]);
    wakes.after("acc_1");
    wakes.after("acc_1");
    wakes.roundEnded("acc_2");
    wakes.roundEnded("acc_1");
    wakes.roundEnded("acc_1");
    expect(woken).toEqual(["acc_1"]);
  });
});
