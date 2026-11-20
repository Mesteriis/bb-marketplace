import { describe, expect, it } from "vitest";
import { UTC_TIME, senderInsights, smartSendTime, type Exchange } from "./sender-rhythm.ts";

// 2026-11-20 is a Friday. Every date is UTC and the rules read it with UTC_TIME, so the machine's zone does not matter.
const NOW = new Date("2026-11-20T10:30:00.000Z");
const OWN = new Set(["owner@example.org"]);

const incoming = (date: string, extra: Partial<Exchange["incoming"][number]> = {}) => ({ date, messageId: `in-${date}`, inReplyTo: null, others: [], ...extra });
const outgoing = (date: string, extra: Partial<Exchange["outgoing"][number]> = {}) => ({ date, messageId: `out-${date}`, inReplyTo: null, ...extra });

/** Five weekday mornings around 09:00 and one at 14:00. */
const MORNINGS: Exchange = {
  incoming: [
    incoming("2026-11-16T09:05:00.000Z"),
    incoming("2026-11-17T09:40:00.000Z"),
    incoming("2026-11-18T09:10:00.000Z"),
    incoming("2026-11-19T08:55:00.000Z"),
    incoming("2026-11-12T09:30:00.000Z"),
    incoming("2026-11-13T14:00:00.000Z"),
  ],
  outgoing: [],
};

describe("smartSendTime", () => {
  it("is the next usual hour on a usual day, at least an hour from now", () => {
    // Friday 10:30: today's 09:00 has passed; they write on weekdays only, so Monday 09:00.
    expect(smartSendTime(MORNINGS, NOW, UTC_TIME)).toEqual({ at: "2026-11-23T09:00:00.000Z", hour: 9 });
    // Friday 07:30: today's 09:00 is 90 minutes away.
    expect(smartSendTime(MORNINGS, new Date("2026-11-20T07:30:00.000Z"), UTC_TIME)).toEqual({ at: "2026-11-20T09:00:00.000Z", hour: 9 });
    // Friday 08:30: 09:00 is closer than an hour, so the next usual day.
    expect(smartSendTime(MORNINGS, new Date("2026-11-20T08:30:00.000Z"), UTC_TIME)).toEqual({ at: "2026-11-23T09:00:00.000Z", hour: 9 });
  });

  it("uses any day for someone who also writes at weekends", () => {
    const weekend: Exchange = {
      incoming: ["2026-11-14T20:10:00.000Z", "2026-11-15T20:20:00.000Z", "2026-11-16T20:30:00.000Z", "2026-11-17T20:40:00.000Z", "2026-11-18T20:50:00.000Z"].map((d) => incoming(d)),
      outgoing: [],
    };
    // Friday 21:00: tomorrow, Saturday, 20:00.
    expect(smartSendTime(weekend, new Date("2026-11-20T21:00:00.000Z"), UTC_TIME)).toEqual({ at: "2026-11-21T20:00:00.000Z", hour: 20 });
  });

  it("says nothing from fewer than five messages", () => {
    expect(smartSendTime({ incoming: MORNINGS.incoming.slice(0, 4), outgoing: [] }, NOW, UTC_TIME)).toBeNull();
    expect(smartSendTime({ incoming: [], outgoing: [] }, NOW, UTC_TIME)).toBeNull();
  });

  it("takes the earlier hour of a tie", () => {
    const tie: Exchange = {
      incoming: ["2026-11-16T15:00:00.000Z", "2026-11-17T15:00:00.000Z", "2026-11-18T11:00:00.000Z", "2026-11-19T11:00:00.000Z", "2026-11-12T08:00:00.000Z"].map((d) => incoming(d)),
      outgoing: [],
    };
    expect(smartSendTime(tie, NOW, UTC_TIME)?.hour).toBe(11);
  });
});

describe("senderInsights", () => {
  it("gives the usual span and days, the reply medians and who they write with", () => {
    const exchange: Exchange = {
      incoming: [
        ...MORNINGS.incoming,
        // Their answers to the owner: 30, 60 and 600 minutes later.
        incoming("2026-11-10T10:30:00.000Z", { inReplyTo: "o1", others: ["bob@example.com", "owner@example.org"] }),
        incoming("2026-11-11T11:00:00.000Z", { inReplyTo: "o2", others: ["Bob@Example.com", "cat@example.net"] }),
        incoming("2026-11-12T20:00:00.000Z", { inReplyTo: "o3", others: ["dan@example.net"] }),
      ],
      outgoing: [
        outgoing("2026-11-10T10:00:00.000Z", { messageId: "o1" }),
        outgoing("2026-11-11T10:00:00.000Z", { messageId: "o2" }),
        outgoing("2026-11-12T10:00:00.000Z", { messageId: "o3" }),
        // The owner's answers to them: 10, 20 and 40 minutes later.
        outgoing("2026-11-16T09:15:00.000Z", { inReplyTo: "in-2026-11-16T09:05:00.000Z" }),
        outgoing("2026-11-17T10:00:00.000Z", { inReplyTo: "in-2026-11-17T09:40:00.000Z" }),
        outgoing("2026-11-18T09:50:00.000Z", { inReplyTo: "in-2026-11-18T09:10:00.000Z" }),
      ],
    };
    expect(senderInsights(exchange, OWN, UTC_TIME)).toEqual({
      theirReplyMinutes: 60,
      ownReplyMinutes: 20,
      usualFrom: 8,
      usualTo: 11,
      weekdaysOnly: true,
      mostWith: [{ address: "bob@example.com", count: 2 }],
    });
  });

  it("leaves out a median from fewer than three pairs and pairs more than 14 days apart", () => {
    const exchange: Exchange = {
      incoming: [
        ...MORNINGS.incoming,
        incoming("2026-11-10T10:30:00.000Z", { inReplyTo: "o1" }),
        incoming("2026-11-11T11:00:00.000Z", { inReplyTo: "o2" }),
        incoming("2026-11-30T11:00:00.000Z", { inReplyTo: "o3" }),
      ],
      outgoing: [outgoing("2026-11-10T10:00:00.000Z", { messageId: "o1" }), outgoing("2026-11-11T10:00:00.000Z", { messageId: "o2" }), outgoing("2026-11-12T10:00:00.000Z", { messageId: "o3" })],
    };
    expect(senderInsights(exchange, OWN, UTC_TIME)).toMatchObject({ theirReplyMinutes: null, ownReplyMinutes: null, mostWith: [] });
  });

  it("says nothing from fewer than five messages", () => {
    expect(senderInsights({ incoming: MORNINGS.incoming.slice(0, 4), outgoing: [] }, OWN, UTC_TIME)).toBeNull();
  });
});
