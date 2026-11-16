// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fetchAge, outstandingCount, selectionOrder, type Status } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

describe("fetchAge", () => {
  it("says a fresh check in minutes and does not call it stale", () => {
    expect(fetchAge(NOW - 4 * MINUTE, NOW)).toEqual({
      label: "checked 4 minutes ago",
      stale: false,
    });
    expect(fetchAge(NOW - MINUTE, NOW).label).toBe("checked 1 minute ago");
    expect(fetchAge(NOW - 1000, NOW).label).toBe("checked just now");
  });

  it("climbs to hours and days", () => {
    expect(fetchAge(NOW - 2 * HOUR, NOW).label).toBe("checked 2 hours ago");
    expect(fetchAge(NOW - 3 * DAY, NOW).label).toBe("checked 3 days ago");
    expect(fetchAge(NOW - 25 * HOUR, NOW).label).toBe("checked 1 day ago");
  });

  it("calls anything an hour or older stale", () => {
    expect(fetchAge(NOW - HOUR, NOW).stale).toBe(true);
    expect(fetchAge(NOW - HOUR + 1, NOW).stale).toBe(false);
  });

  it("tracks the schedule when auto-fetch is on", () => {
    // Six hours old under a six-hourly schedule is the normal resting state,
    // not a warning. The same age with no schedule running is stale.
    expect(fetchAge(NOW - 6 * HOUR, NOW, 6).stale).toBe(false);
    expect(fetchAge(NOW - 6 * HOUR, NOW, 0).stale).toBe(true);
    // Past the interval plus its grace, a scheduled fetch has been missed.
    expect(fetchAge(NOW - 7 * HOUR, NOW, 6).stale).toBe(true);
    // A tighter schedule tightens the threshold with it.
    expect(fetchAge(NOW - 2 * HOUR, NOW, 1).stale).toBe(true);
  });

  it("treats a clone that never fetched as stale, not as recent", () => {
    expect(fetchAge(null, NOW)).toEqual({ label: "never checked", stale: true });
  });

  it("does not read a future timestamp as a negative age", () => {
    expect(fetchAge(NOW + DAY, NOW)).toEqual({
      label: "checked just now",
      stale: false,
    });
  });
});

function status(overrides: Partial<Status> = {}): Status {
  return {
    sourceId: "matt",
    pinned: "aaaaaaa",
    head: "bbbbbbb",
    commits: [],
    skills: [],
    foreign: [],
    catalogue: [],
    fetchedAt: null,
    autoFetchHours: 0,
    ...overrides,
  };
}

function skill(name: string, bucket: Status["skills"][number]["bucket"]) {
  return {
    name,
    bucket,
    upstreamBucket: "",
    substantiveFiles: [],
    cosmeticFiles: [],
    localEditedFiles: [],
  };
}

describe("outstandingCount", () => {
  it("counts only what the user can still decide", () => {
    expect(
      outstandingCount(
        status({
          skills: [
            skill("a", "new"),
            skill("b", "clean"),
            skill("c", "dirty-only"),
            skill("d", "dirty-conflict"),
            skill("e", "deprecated"),
          ],
        }),
      ),
    ).toBe(3);
  });

  it("counts a conflict, the case that most needs a human", () => {
    expect(
      outstandingCount(status({ skills: [skill("d", "dirty-conflict")] })),
    ).toBe(1);
  });

  it("leaves out the buckets with no upstream change to take", () => {
    expect(
      outstandingCount(
        status({
          skills: [skill("c", "dirty-only"), skill("e", "deprecated")],
        }),
      ),
    ).toBe(0);
  });

  it("ignores catalogue entries the user already declined", () => {
    expect(
      outstandingCount(
        status({
          catalogue: [
            { name: "x", upstreamBucket: "", description: "", offered: false },
          ],
        }),
      ),
    ).toBe(0);
  });
});

describe("selectionOrder", () => {
  it("keeps a catalogue-only pick that has no skill row", () => {
    const value = status({
      skills: [skill("clean-one", "clean"), skill("brand-new", "new")],
      catalogue: [
        { name: "brand-new", upstreamBucket: "", description: "", offered: true },
        { name: "declined", upstreamBucket: "", description: "", offered: false },
      ],
    });
    expect(
      selectionOrder(value, new Set(["declined", "brand-new", "clean-one"])),
    ).toEqual(["clean-one", "brand-new", "declined"]);
  });

  it("drops names that are neither installed nor upstream", () => {
    expect(selectionOrder(status(), new Set(["ghost"]))).toEqual([]);
  });
});
