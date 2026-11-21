// One-time tickets for opening a call in the system browser. The page served
// for a ticket carries the meeting's signature and ZAK, so a ticket works
// once, for two minutes, and only a handful exist at a time.
import type { PreparedCall } from "../../core/call.ts";
import type { Clock } from "../../core/ports.ts";

const TICKET_TTL_MS = 2 * 60_000;
const MAX_TICKETS = 10;

export interface CallTickets {
  issue(call: PreparedCall): string;
  /** Returns the call and forgets the ticket. */
  redeem(ticket: string): PreparedCall | null;
}

export function createCallTickets(clock: Clock, newTicket: () => string): CallTickets {
  const tickets = new Map<string, { call: PreparedCall; issuedAt: number }>();
  return {
    issue(call) {
      const ticket = newTicket();
      tickets.set(ticket, { call, issuedAt: clock.now() });
      while (tickets.size > MAX_TICKETS) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined) break;
        tickets.delete(oldest);
      }
      return ticket;
    },
    redeem(ticket) {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (entry === undefined || clock.now() - entry.issuedAt > TICKET_TTL_MS) return null;
      return entry.call;
    },
  };
}
