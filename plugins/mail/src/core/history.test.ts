import { describe, expect, it } from "vitest";
import {
  CONVERSATION_IDS_MAX,
  CONVERSATION_MAX,
  HISTORY_EMPTY_STEPS,
  HISTORY_STEP_MAX,
  conversationSearches,
  emptyStepsNote,
  historyRange,
  jobInsertable,
  nextHistorySince,
} from "./history.ts";

describe("historyRange", () => {
  it("steps back from the synced window when nothing was loaded", () => {
    expect(historyRange({ historySince: null, syncedSince: "2026-10-17T00:00:00.000Z" }, 30)).toEqual({
      from: "2026-09-17T00:00:00.000Z",
      before: "2026-10-17T00:00:00.000Z",
    });
  });

  it("continues from the loaded history", () => {
    expect(historyRange({ historySince: "2026-09-17T00:00:00.000Z", syncedSince: "2026-10-17T00:00:00.000Z" }, 7)).toEqual({
      from: "2026-09-10T00:00:00.000Z",
      before: "2026-09-17T00:00:00.000Z",
    });
  });
});

describe("nextHistorySince", () => {
  const range = { from: "2026-09-17T00:00:00.000Z", before: "2026-10-17T00:00:00.000Z" };

  it("moves to the range start when the step fetched all of its new messages", () => {
    expect(nextHistorySince(range, { newCount: 120, stopped: false })).toBe(range.from);
    expect(nextHistorySince(range, { newCount: HISTORY_STEP_MAX, stopped: false })).toBe(range.from);
  });

  it("moves to the range start after an empty step", () => {
    expect(nextHistorySince(range, { newCount: 0, stopped: false })).toBe(range.from);
  });

  it("stays put when the step had more than 500 new messages: the same range runs again", () => {
    expect(nextHistorySince(range, { newCount: HISTORY_STEP_MAX + 1, stopped: false })).toBeNull();
    expect(nextHistorySince(range, { newCount: 900, stopped: false })).toBeNull();
  });

  it("stays put when the step stopped early", () => {
    expect(nextHistorySince(range, { newCount: 10, stopped: true })).toBeNull();
  });
});


describe("emptyStepsNote", () => {
  it("speaks after three empty steps in a row", () => {
    expect(HISTORY_EMPTY_STEPS).toBe(3);
    expect(emptyStepsNote(2)).toBeNull();
    expect(emptyStepsNote(3)).toBe("No older mail on the server in this folder");
  });
});

describe("conversationSearches", () => {
  it("uses Gmail's thread id when there is one", () => {
    expect(conversationSearches({ messageIds: ["<a@example.org>"], refs: [], gmThrid: "1789" })).toEqual({
      kind: "gmail",
      threadId: "1789",
    });
  });

  it("searches References and Message-ID headers for each id, deduplicated", () => {
    expect(
      conversationSearches({ messageIds: ["<a@example.org>", "<b@example.org>"], refs: ["<a@example.org>", ""], gmThrid: null }),
    ).toEqual({
      kind: "headers",
      searches: [
        { header: "References", value: "<a@example.org>" },
        { header: "Message-ID", value: "<a@example.org>" },
        { header: "References", value: "<b@example.org>" },
        { header: "Message-ID", value: "<b@example.org>" },
      ],
    });
  });

  it("caps the ids at 50", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `<m${i}@example.org>`);
    const plan = conversationSearches({ messageIds: ids, refs: [], gmThrid: null });
    expect(plan.kind === "headers" && plan.searches.length).toBe(CONVERSATION_IDS_MAX * 2);
    expect(CONVERSATION_IDS_MAX).toBe(50);
    expect(CONVERSATION_MAX).toBe(100);
  });
});

describe("jobInsertable", () => {
  const state = { uidValidity: 7, lastUid: 100 };

  it("keeps uids up to last_uid and counts the rest as skipped", () => {
    expect(jobInsertable([5, 100, 101, 250], state, 7)).toEqual({ uids: [5, 100], skipped: 2 });
  });

  it("skips everything for a folder with no sync state", () => {
    expect(jobInsertable([5, 6], null, 7)).toEqual({ uids: [], skipped: 2, reason: "not_synced" });
  });

  it("skips everything when UIDVALIDITY changed", () => {
    expect(jobInsertable([5, 6], state, 8)).toEqual({ uids: [], skipped: 2, reason: "changed" });
  });
});
