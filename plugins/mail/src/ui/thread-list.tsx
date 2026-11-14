// The left column: conversations (or search hits) as dense rows, unread in bold.
import type { MailAddress, MessageSummary, ThreadSummary } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const NO_SUBJECT = "(no subject)";

/** The subject to show, or a placeholder for an empty one. */
export function subjectOrPlaceholder(subject: string): string {
  return subject.trim() || NO_SUBJECT;
}

/** A person's name, else their address. */
export function addressLabel(address: MailAddress): string {
  return address.name?.trim() || address.address;
}

/** Short date for a list row: the time today, the day this year, else the full date. */
export function formatListDate(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Date and time for a message header. */
export function formatFullDate(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function participantsLabel(participants: MailAddress[], ownAddress: string | null): string {
  const own = ownAddress?.toLowerCase() ?? null;
  const others = participants.filter((p) => p.address.toLowerCase() !== own);
  const shown = others.length > 0 ? others : participants;
  if (shown.length === 0) return "Unknown sender";
  return shown.map(addressLabel).join(", ");
}

interface RowProps {
  selected: boolean;
  unread: boolean;
  people: string;
  date: string | null;
  count?: number;
  subject: string;
  snippet: string;
  onSelect: () => void;
}

function Row({ selected, unread, people, date, count, subject, snippet, onSelect }: RowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 self-center rounded-full", unread ? "bg-primary" : "bg-transparent")}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm text-foreground",
              unread && "font-semibold",
            )}
          >
            {people}
          </span>
          {count !== undefined && count > 1 ? (
            <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
          ) : null}
          {date !== null ? (
            <time dateTime={date} className="shrink-0 text-xs text-muted-foreground">
              {formatListDate(date)}
            </time>
          ) : null}
        </span>
        <span className={cn("truncate pl-3.5 text-sm text-foreground", unread && "font-semibold")}>
          {unread ? <span className="sr-only">Unread: </span> : null}
          {subjectOrPlaceholder(subject)}
        </span>
        <span className="truncate pl-3.5 text-xs text-muted-foreground">{snippet}</span>
      </button>
    </li>
  );
}

export interface ThreadListProps {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  /** The account's own address, left out of the participants shown. */
  ownAddress: string | null;
  onSelect: (threadId: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function ThreadList({
  threads,
  selectedThreadId,
  ownAddress,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: ThreadListProps) {
  return (
    <div className="flex flex-col">
      <ul aria-label="Conversations">
        {threads.map((thread) => (
          <Row
            key={thread.id}
            selected={thread.id === selectedThreadId}
            unread={thread.unreadCount > 0}
            people={participantsLabel(thread.participants, ownAddress)}
            date={thread.lastDate}
            count={thread.messageCount}
            subject={thread.subject}
            snippet={thread.snippet}
            onSelect={() => onSelect(thread.id)}
          />
        ))}
      </ul>
      {hasMore ? (
        <div className="p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface SearchResultListProps {
  hits: MessageSummary[];
  selectedThreadId: string | null;
  onSelect: (threadId: string, messageId: string) => void;
}

export function SearchResultList({ hits, selectedThreadId, onSelect }: SearchResultListProps) {
  return (
    <ul aria-label="Search results">
      {hits.map((hit) => (
        <Row
          key={hit.id}
          selected={hit.threadId === selectedThreadId}
          unread={!hit.isRead}
          people={addressLabel(hit.from)}
          date={hit.date}
          subject={hit.subject}
          snippet={hit.snippet}
          onSelect={() => onSelect(hit.threadId, hit.id)}
        />
      ))}
    </ul>
  );
}
