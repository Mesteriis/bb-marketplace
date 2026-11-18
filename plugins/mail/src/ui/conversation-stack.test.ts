import { describe, expect, it } from "vitest";
import type { MessageHeader } from "../core/index.ts";
import { splitConversation, stackSummary } from "./conversation-stack.ts";

const ids = (list: readonly { id: string }[]) => list.map((m) => m.id);
const six = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => ({ id }));
const set = (...values: string[]) => new Set(values);

describe("splitConversation", () => {
  it("one earlier message is no stack", () => {
    const { stacked, shown } = splitConversation(six.slice(4), { anchorIds: set("m6"), expandedIds: set("m6"), open: false });
    expect(stacked).toEqual([]);
    expect(ids(shown)).toEqual(["m5", "m6"]);
  });

  it("five earlier read messages form a stack of five", () => {
    const { stacked, shown } = splitConversation(six, { anchorIds: set("m6"), expandedIds: set("m6"), open: false });
    expect(ids(stacked)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(ids(shown)).toEqual(["m6"]);
  });

  it("an unread-at-open message in the middle bounds the stack", () => {
    const { stacked, shown } = splitConversation(six, { anchorIds: set("m6", "m3"), expandedIds: set("m6"), open: false });
    expect(ids(stacked)).toEqual(["m1", "m2"]);
    expect(ids(shown)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("an expanded message inside the range moves the boundary", () => {
    const { stacked } = splitConversation(six, { anchorIds: set("m6"), expandedIds: set("m6", "m4"), open: false });
    expect(ids(stacked)).toEqual(["m1", "m2", "m3"]);
    expect(splitConversation(six, { anchorIds: set("m6"), expandedIds: set("m2"), open: false }).stacked).toEqual([]);
  });

  it("open shows all", () => {
    expect(splitConversation(six, { anchorIds: set("m6"), expandedIds: set(), open: true })).toEqual({ stacked: [], shown: six });
  });

  it("messages loaded before the boundary join the stack", () => {
    const more = [{ id: "m0" }, ...six];
    expect(ids(splitConversation(more, { anchorIds: set("m6"), expandedIds: set("m6"), open: false }).stacked)).toEqual([
      "m0", "m1", "m2", "m3", "m4", "m5",
    ]);
  });

  it("without an anchor the newest still shows", () => {
    expect(ids(splitConversation(six, { anchorIds: set(), expandedIds: set(), open: false }).shown)).toEqual(["m6"]);
  });
});

describe("stackSummary", () => {
  const header = (name: string | null, address: string, date: string, extra: Partial<MessageHeader> = {}) => ({
    from: { name, address },
    date,
    ...extra,
  });

  it("names up to three senders and the date range", () => {
    const summary = stackSummary([
      header("Anna", "anna@example.org", "2026-11-01T08:00:00.000Z"),
      header("Boris", "boris@example.org", "2026-11-03T08:00:00.000Z"),
      header("Anna", "anna@example.org", "2026-11-02T08:00:00.000Z"),
    ]);
    expect(summary).toEqual({ count: 3, senders: "Anna and Boris", from: "2026-11-01T08:00:00.000Z", to: "2026-11-03T08:00:00.000Z", warned: false });
    const many = stackSummary(["A", "B", "C", "D"].map((n, i) => header(n, `${n.toLowerCase()}@example.org`, `2026-11-0${i + 1}T08:00:00.000Z`)));
    expect(many.senders).toBe("A, B and 2 others");
    expect(stackSummary(["A", "B", "C"].map((n) => header(n, `${n}@example.org`, "2026-11-01T08:00:00.000Z"))).senders).toBe("A, B and C");
  });

  it("shows the address for a name that shows another address, and marks warnings", () => {
    const summary = stackSummary([
      header("ceo@example.com", "x@example.org", "2026-11-01T08:00:00.000Z", {
        warnings: [{ kind: "name_shows_address", shown: "ceo@example.com", actual: "x@example.org" }],
      }),
      header("Bo", "bo@example.org", "2026-11-02T08:00:00.000Z"),
    ]);
    expect(summary.senders).toBe("x@example.org and Bo");
    expect(summary.warned).toBe(true);
    expect(stackSummary([header("Bo", "bo@example.org", "2026-11-02T08:00:00.000Z", { senderCheck: { state: "failed", summary: null } })]).warned).toBe(true);
  });
});
