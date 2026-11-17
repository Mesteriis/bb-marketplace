import { describe, expect, it } from "vitest";
import {
  INVITE_MAX_ATTENDEES,
  buildInviteReply,
  isCalendarPart,
  parseInvite,
} from "./calendar-invite.ts";

const ics = (lines: string[]) => lines.join("\r\n");

const REQUEST = ics([
  "BEGIN:VCALENDAR",
  "PRODID:-//Invented//Calendar//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:event-1@example.org",
  "SEQUENCE:2",
  "DTSTAMP:20261117T080000Z",
  "DTSTART:20261120T090000Z",
  "DTEND:20261120T093000Z",
  "SUMMARY:Invented planning\\, part two",
  "LOCATION:Room 4\; second floor",
  "DESCRIPTION:First line\\nSecond line with a very long text that is folded ov",
  " er two lines",
  'ORGANIZER;CN="Olga Organizer":mailto:Olga@Example.org',
  "ATTENDEE;CN=Owner;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:owner@example.org",
  "ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:MAILTO:bob@example.com",
  "ATTENDEE;PARTSTAT=DECLINED:mailto:carol@example.com",
  "ATTENDEE:urn:uuid:not-an-address",
  "END:VEVENT",
  "END:VCALENDAR",
]);

describe("parseInvite", () => {
  it("reads what, when, where and who of a request", () => {
    const invite = parseInvite(REQUEST, new Set(["owner@example.org"]))!;
    expect(invite).toEqual({
      method: "request",
      uid: "event-1@example.org",
      sequence: 2,
      summary: "Invented planning, part two",
      location: "Room 4; second floor",
      description: "First line\nSecond line with a very long text that is folded over two lines",
      start: { utc: "2026-11-20T09:00:00.000Z", wall: "2026-11-20T09:00", zone: "UTC", allDay: false },
      end: { utc: "2026-11-20T09:30:00.000Z", wall: "2026-11-20T09:30", zone: "UTC", allDay: false },
      organizer: { name: "Olga Organizer", address: "olga@example.org" },
      attendees: [
        { name: "Owner", address: "owner@example.org", status: "needs_action", optional: false },
        { name: null, address: "bob@example.com", status: "accepted", optional: true },
        { name: null, address: "carol@example.com", status: "declined", optional: false },
      ],
      attendeesTotal: 3,
      recurring: false,
      cancelled: false,
      self: { address: "owner@example.org", status: "needs_action" },
    });
    expect(parseInvite(REQUEST)!.self).toBeNull();
  });

  it("resolves a time in a zone the runtime knows, on both sides of a clock change", () => {
    const at = (start: string) =>
      parseInvite(ics(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u", `DTSTART;TZID=Europe/Madrid:${start}`, "END:VEVENT", "END:VCALENDAR"]))!.start;
    expect(at("20261120T090000")).toEqual({ utc: "2026-11-20T08:00:00.000Z", wall: "2026-11-20T09:00", zone: "Europe/Madrid", allDay: false });
    expect(at("20260720T090000")!.utc).toBe("2026-07-20T07:00:00.000Z");
  });

  it("resolves an Outlook zone name through the VTIMEZONE the file carries", () => {
    const zone = [
      "BEGIN:VTIMEZONE",
      "TZID:Romance Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ];
    const at = (start: string) =>
      parseInvite(
        ics(["BEGIN:VCALENDAR", ...zone, "BEGIN:VEVENT", "UID:u", `DTSTART;TZID="Romance Standard Time":${start}`, "END:VEVENT", "END:VCALENDAR"]),
      )!.start!;
    expect(at("20261120T090000")).toEqual({
      utc: "2026-11-20T08:00:00.000Z",
      wall: "2026-11-20T09:00",
      zone: "Romance Standard Time",
      allDay: false,
    });
    expect(at("20260720T090000").utc).toBe("2026-07-20T07:00:00.000Z");
    // The last Sunday of October 2026 is the 25th: summer time the day before, winter time the day after.
    expect(at("20261024T120000").utc).toBe("2026-10-24T10:00:00.000Z");
    expect(at("20261026T120000").utc).toBe("2026-10-26T11:00:00.000Z");
    // January: the last onset was the October before.
    expect(at("20270115T120000").utc).toBe("2027-01-15T11:00:00.000Z");
  });

  it("keeps the time as written when the zone is unknown or absent, and reads a whole day", () => {
    const event = (lines: string[]) => parseInvite(ics(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u", ...lines, "END:VEVENT", "END:VCALENDAR"]))!;
    expect(event(["DTSTART;TZID=Made Up Time:20261120T090000"]).start).toEqual({
      utc: null,
      wall: "2026-11-20T09:00",
      zone: "Made Up Time",
      allDay: false,
    });
    expect(event(["DTSTART:20261120T090000"]).start).toEqual({ utc: null, wall: "2026-11-20T09:00", zone: null, allDay: false });
    const day = event(["DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261122"]);
    expect(day.start).toEqual({ utc: null, wall: "2026-11-20", zone: null, allDay: true });
    expect(day.end!.wall).toBe("2026-11-22");
    expect(event(["DTSTART:not a date"]).start).toBeNull();
  });

  it("knows a cancellation, a reply, a repeating event, and prefers the series over one changed occurrence", () => {
    const cancel = parseInvite(REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL"))!;
    expect(cancel).toMatchObject({ method: "cancel", cancelled: true });
    expect(parseInvite(REQUEST.replace("SEQUENCE:2", "SEQUENCE:2\r\nSTATUS:CANCELLED"))!.cancelled).toBe(true);
    expect(parseInvite(REQUEST.replace("METHOD:REQUEST", "METHOD:REPLY"))!.method).toBe("reply");
    expect(parseInvite(REQUEST.replace("METHOD:REQUEST\r\n", ""))!.method).toBe("other");
    const series = parseInvite(
      ics([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:u",
        "RECURRENCE-ID:20261127T090000Z",
        "SUMMARY:Moved once",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:u",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Weekly",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
    )!;
    expect(series).toMatchObject({ summary: "Weekly", recurring: true });
  });

  it("is null without a calendar or an event", () => {
    expect(parseInvite("")).toBeNull();
    expect(parseInvite("hello")).toBeNull();
    expect(parseInvite(ics(["BEGIN:VCALENDAR", "METHOD:REQUEST", "END:VCALENDAR"]))).toBeNull();
    expect(parseInvite(ics(["BEGIN:VEVENT", "UID:u", "END:VEVENT"]))).toBeNull();
  });

  it("strips hostile text and caps what it returns", () => {
    const many = Array.from({ length: INVITE_MAX_ATTENDEES + 30 }, (_, i) => `ATTENDEE:mailto:person${i}@example.com`);
    const invite = parseInvite(
      ics([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:u",
        `SUMMARY:Pay now\u202e\u0007 <script>alert(1)</script>${"x".repeat(1000)}`,
        `DESCRIPTION:${"y".repeat(5000)}`,
        'ORGANIZER;CN="Boss\u202e":mailto:boss@example.com\\nATTENDEE:mailto:evil@example.com',
        ...many,
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
    )!;
    expect(invite.summary.startsWith("Pay now <script>alert(1)</script>xxx")).toBe(true);
    expect(invite.summary).toHaveLength(300);
    expect(invite.description).toHaveLength(2000);
    expect(invite.organizer).toBeNull();
    expect(invite.attendees).toHaveLength(INVITE_MAX_ATTENDEES);
    expect(invite.attendeesTotal).toBe(INVITE_MAX_ATTENDEES + 30);
  });

  it("reads a large hostile file in bounded time", () => {
    const text = ics(["BEGIN:VCALENDAR", ...Array.from({ length: 200_000 }, () => "BEGIN:VEVENT"), "END:VCALENDAR"]);
    const start = performance.now();
    parseInvite(text);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("isCalendarPart", () => {
  it("knows a calendar part by its type, or an .ics file sent as plain bytes", () => {
    expect(isCalendarPart({ mimeType: "text/calendar", filename: null })).toBe(true);
    expect(isCalendarPart({ mimeType: "Application/ICS", filename: "invite.ics" })).toBe(true);
    expect(isCalendarPart({ mimeType: "application/octet-stream", filename: "Invite.ICS" })).toBe(true);
    expect(isCalendarPart({ mimeType: "application/octet-stream", filename: "notes.txt" })).toBe(false);
    expect(isCalendarPart({ mimeType: "text/plain", filename: "invite.ics" })).toBe(false);
  });
});

describe("buildInviteReply", () => {
  const now = new Date("2026-11-17T10:00:00.000Z");
  const invite = parseInvite(REQUEST)!;

  it("answers with the event's UID and SEQUENCE, the organizer and the one attendee", () => {
    const reply = buildInviteReply(invite, { name: "Owner", address: "owner@example.org" }, "accepted", now)!;
    expect(reply.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR",
      "PRODID:-//Makosh//Mail//EN",
      "VERSION:2.0",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      "UID:event-1@example.org",
      "SEQUENCE:2",
      "DTSTAMP:20261117T100000Z",
      'ORGANIZER;CN="Olga Organizer":mailto:olga@example.org',
      'ATTENDEE;PARTSTAT=ACCEPTED;CN="Owner":mailto:owner@example.org',
      "SUMMARY:Invented planning\\, part two",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
    // What it builds reads back as a reply from that attendee.
    const back = parseInvite(reply, new Set(["owner@example.org"]))!;
    expect(back).toMatchObject({ method: "reply", uid: invite.uid, sequence: 2, self: { status: "accepted" } });
    expect(buildInviteReply(invite, { name: null, address: "owner@example.org" }, "declined", now)).toContain(
      "ATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.org",
    );
    expect(buildInviteReply(invite, { name: null, address: "owner@example.org" }, "tentative", now)).toContain("PARTSTAT=TENTATIVE");
  });

  it("keeps a name from breaking out of its line and folds long lines at 75 octets", () => {
    const reply = buildInviteReply(
      { ...invite, summary: "\u0416".repeat(120) },
      { name: 'Owner";PARTSTAT=DECLINED\r\nATTENDEE:mailto:x@example.com', address: "owner@example.org" },
      "accepted",
      now,
    )!;
    const lines = reply.split("\r\n");
    expect(lines.filter((line) => line.startsWith("ATTENDEE"))).toHaveLength(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(parseInvite(reply)!.summary).toBe("\u0416".repeat(120));
    expect(parseInvite(reply)!.attendees).toEqual([
      { name: "Owner;PARTSTAT=DECLINED ATTENDEE:mailto:x@example.com", address: "owner@example.org", status: "accepted", optional: false },
    ]);
  });

  it("is null without a UID or an organizer", () => {
    expect(buildInviteReply({ ...invite, uid: null }, { name: null, address: "owner@example.org" }, "accepted", now)).toBeNull();
    expect(buildInviteReply({ ...invite, organizer: null }, { name: null, address: "owner@example.org" }, "accepted", now)).toBeNull();
  });
});
