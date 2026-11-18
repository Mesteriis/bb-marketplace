// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InviteView } from "../core/calendar-invite.ts";
import { InviteCard, inviteWhenText, type InvitePorts } from "./invite-card.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function invite(overrides: Partial<InviteView> = {}): InviteView {
  return {
    method: "request",
    uid: "event-1@example.org",
    sequence: 0,
    summary: "Invented planning",
    location: "Room 4",
    description: "Bring the made-up numbers.",
    start: { utc: "2026-11-20T09:00:00.000Z", wall: "2026-11-20T09:00", zone: "UTC", allDay: false },
    end: { utc: "2026-11-20T09:30:00.000Z", wall: "2026-11-20T09:30", zone: "UTC", allDay: false },
    organizer: { name: "Olga Organizer", address: "olga@example.org" },
    attendees: [
      { name: "Owner", address: "owner@example.org", status: "needs_action", optional: false },
      { name: null, address: "bob@example.com", status: "accepted", optional: true },
    ],
    attendeesTotal: 2,
    recurring: false,
    cancelled: false,
    self: { address: "owner@example.org", status: "needs_action" },
    ...overrides,
  };
}

function ports(view: { invite: InviteView | null; answerable: boolean }): InvitePorts & { reply: ReturnType<typeof vi.fn> } {
  return { view: vi.fn(async () => view), reply: vi.fn(async () => undefined) };
}

describe("InviteCard (slice 3l)", () => {
  it("shows what, when, where and who, and sends the owner's answer on a click only", async () => {
    const p = ports({ invite: invite(), answerable: true });
    render(<InviteCard messageId="m_1" ports={p} />);
    const card = await screen.findByRole("region", { name: "Calendar invitation" });
    expect(within(card).getByText("Invitation")).toBeTruthy();
    expect(within(card).getByText("Invented planning")).toBeTruthy();
    expect(within(card).getByText("Room 4")).toBeTruthy();
    expect(within(card).getByText("Olga Organizer <olga@example.org>")).toBeTruthy();
    const invited = within(card).getByRole("list", { name: "Invited" });
    expect(within(invited).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Owner <owner@example.org> \u00b7 no answer yet",
      "bob@example.com \u00b7 accepted, optional",
    ]);
    expect(p.reply).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(p.reply).toHaveBeenCalledWith("m_1", "declined"));
    expect((await within(card).findByRole("status")).textContent).toBe("Your answer is on its way: declined.");
    expect(within(card).queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("offers no answer for a cancellation, a reply, or an invitation that is not the owner's", async () => {
    const cancelled = ports({ invite: invite({ method: "cancel", cancelled: true }), answerable: false });
    const { unmount } = render(<InviteCard messageId="m_1" ports={cancelled} />);
    expect(await screen.findByText("Cancelled event")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    unmount();
    const reply = ports({
      invite: invite({
        method: "reply",
        attendees: [{ name: null, address: "bob@example.com", status: "tentative", optional: false }],
        attendeesTotal: 1,
        self: null,
      }),
      answerable: false,
    });
    render(<InviteCard messageId="m_2" ports={reply} />);
    expect(await screen.findByText("Answer to an invitation")).toBeTruthy();
    expect(screen.getByText("bob@example.com: maybe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("shows a refusal from the server and keeps the buttons", async () => {
    const p = ports({ invite: invite(), answerable: true });
    p.reply.mockRejectedValueOnce(new Error("Too many sends in a minute"));
    render(<InviteCard messageId="m_1" ports={p} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many sends in a minute");
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("renders nothing when the part holds no event, and offers Retry when the server cannot be read", async () => {
    const none = ports({ invite: null, answerable: false });
    const { container, unmount } = render(<InviteCard messageId="m_1" ports={none} />);
    await waitFor(() => expect(container.textContent).toBe(""));
    unmount();
    const view = vi.fn<InvitePorts["view"]>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ invite: invite(), answerable: false });
    render(<InviteCard messageId="m_1" ports={{ view, reply: vi.fn() }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Invented planning")).toBeTruthy();
  });

  it("opens the rest of a long list on a click and renders hostile text as text", async () => {
    const attendees = Array.from({ length: 8 }, (_, i) => ({
      name: null,
      address: `person${i}@example.com`,
      status: "needs_action" as const,
      optional: false,
    }));
    const p = ports({
      invite: invite({ summary: "<img src=x onerror=alert(1)>", attendees, attendeesTotal: 60, self: null }),
      answerable: false,
    });
    render(<InviteCard messageId="m_1" ports={p} />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Invited" })).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "and 55 more" }));
    expect(within(screen.getByRole("list", { name: "Invited" })).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText("and 52 more")).toBeTruthy();
  });
});

describe("inviteWhenText", () => {
  const moment = (wall: string, utc: string | null, zone: string | null = null) => ({ utc, wall, zone, allDay: false });

  it("shows a known instant in the owner's own time, and one day's range with one date", () => {
    const start = new Date(2026, 10, 20, 9, 0);
    const end = new Date(2026, 10, 20, 9, 30);
    const text = inviteWhenText(moment("x", start.toISOString()), moment("x", end.toISOString()));
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/09:00( AM)? \u2013 09:30( AM)?$/);
    expect(text).not.toMatch(/\(/);
  });

  it("keeps the time as written when the zone is unknown, naming it", () => {
    expect(inviteWhenText(moment("2026-11-20T09:00", null, "Made Up Time"), moment("2026-11-20T10:00", null, "Made Up Time"))).toMatch(
      /09:00( AM)? \u2013 10:00( AM)? \(Made Up Time\)$/,
    );
    expect(inviteWhenText(moment("2026-11-20T09:00", null), null)).toMatch(/09:00( AM)? \(time zone not given\)$/);
  });

  it("reads a whole day, and a span of days up to the day before its end", () => {
    const day = (wall: string) => ({ utc: null, wall, zone: null, allDay: true });
    expect(inviteWhenText(day("2026-11-20"), day("2026-11-21"))).toMatch(/20.*, all day$/);
    const span = inviteWhenText(day("2026-11-20"), day("2026-11-23"));
    expect(span).toMatch(/20.* \u2013 .*22/);
    expect(inviteWhenText(null, null)).toBe("The time is not given");
  });
});
