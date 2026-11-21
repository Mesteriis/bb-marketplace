import { describe, expect, it } from "vitest";
import { createCallTickets } from "./call-tickets.ts";

const CALL = { meetingNumber: "1111111111", passcode: null, userName: "Иван", signature: "sig", zak: "zak", fallbackUrl: "https://zoom.us/j/1111111111" };

function setup() {
  let now = 1_000_000;
  let counter = 0;
  const tickets = createCallTickets({ now: () => now }, () => `ticket-${(counter += 1)}`);
  return { tickets, advance: (ms: number) => (now += ms) };
}

describe("call tickets", () => {
  it("hands a call out once", () => {
    const { tickets } = setup();
    const ticket = tickets.issue(CALL);
    expect(ticket).toBe("ticket-1");
    expect(tickets.redeem(ticket)).toEqual(CALL);
    expect(tickets.redeem(ticket)).toBeNull();
  });

  it("does not know a ticket it never issued", () => {
    expect(setup().tickets.redeem("ticket-9")).toBeNull();
  });

  it("honours a ticket at two minutes and refuses it one millisecond later", () => {
    const onTime = setup();
    const first = onTime.tickets.issue(CALL);
    onTime.advance(120_000);
    expect(onTime.tickets.redeem(first)).toEqual(CALL);

    const late = setup();
    const second = late.tickets.issue(CALL);
    late.advance(120_001);
    expect(late.tickets.redeem(second)).toBeNull();
  });

  it("keeps at most ten tickets, dropping the oldest", () => {
    const { tickets } = setup();
    const issued = Array.from({ length: 11 }, () => tickets.issue(CALL));
    expect(tickets.redeem(issued[0]!)).toBeNull();
    expect(tickets.redeem(issued[1]!)).toEqual(CALL);
    expect(tickets.redeem(issued[10]!)).toEqual(CALL);
  });
});
