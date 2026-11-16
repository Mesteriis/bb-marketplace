// The earlier-messages stack (slice 3i part B, B8): the messages of a
// conversation before the first one that must show wait in one closed
// "N earlier messages" control. Pure; the reading pane renders it and the
// page keeps its open state beside quotesAll (part B resolution 7).
import type { MessageHeader } from "../core/index.ts";
import { hasSenderWarning } from "./sender-warnings.tsx";
import { addressLabel } from "./thread-list.tsx";

export interface StackOptions {
  /** Messages that never hide: the newest, the opened one and every message unread at first render. */
  anchorIds: ReadonlySet<string>;
  /** Messages expanded now (a citation, Expand all, the owner): they never hide either. */
  expandedIds: ReadonlySet<string>;
  /** The owner opened the stack (or Expand all). */
  open: boolean;
}

/** Fewest earlier messages that form a stack; one earlier message just shows. */
export const STACK_MIN = 2;

/**
 * The messages (oldest first) split at the first anchor or expanded one:
 * those before it form the stack when there are at least STACK_MIN and it
 * is closed. Without an anchor the newest still shows.
 */
export function splitConversation<T extends { id: string }>(messages: readonly T[], options: StackOptions): { stacked: T[]; shown: T[] } {
  let boundary = messages.findIndex((m) => options.anchorIds.has(m.id) || options.expandedIds.has(m.id));
  if (boundary === -1) boundary = Math.max(0, messages.length - 1);
  if (options.open || boundary < STACK_MIN) return { stacked: [], shown: [...messages] };
  return { stacked: messages.slice(0, boundary), shown: messages.slice(boundary) };
}

export interface StackSummary {
  count: number;
  /** Up to three senders: "Anna, Boris and 2 others". */
  senders: string;
  /** The oldest and newest dates; null when no message has one. */
  from: string | null;
  to: string | null;
  /** A stacked message has a failed check or a disguise warning (part B I6). */
  warned: boolean;
}

/** "A", "A and B", "A, B and C", "A, B and N others". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * The stack's second line. Senders are named as the headers name them,
 * except a sender whose name shows another address: the address then.
 */
export function stackSummary(messages: readonly Pick<MessageHeader, "from" | "date" | "senderCheck" | "warnings">[]): StackSummary {
  const names: string[] = [];
  const seen = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;
  for (const message of messages) {
    const disguised = (message.warnings ?? []).some((w) => w.kind === "name_shows_address");
    const name = disguised ? message.from.address : addressLabel(message.from);
    const key = `${message.from.address.trim().toLowerCase()}\n${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
    if (message.date !== null) {
      if (from === null || message.date < from) from = message.date;
      if (to === null || message.date > to) to = message.date;
    }
  }
  return { count: messages.length, senders: joinNames(names), from, to, warned: messages.some(hasSenderWarning) };
}
