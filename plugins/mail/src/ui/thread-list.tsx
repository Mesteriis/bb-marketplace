// The left column: conversations (or search hits) as dense rows, unread in bold.
import type { MailAddress, MessageSummary, ThreadSummary } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
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

/** Who a conversation is with: everyone but the account itself, by name where known. */
export function participantsLabel(participants: MailAddress[], ownAddress: string | null): string {
  const own = ownAddress?.toLowerCase() ?? null;
  const others = participants.filter((p) => p.address.toLowerCase() !== own);
  const shown = others.length > 0 ? others : participants;
  if (shown.length === 0) return "Unknown sender";
  return shown.map(addressLabel).join(", ");
}

interface RowProps {
  rowKey: string;
  selected: boolean;
  /** The keyboard cursor is on this row. */
  focused: boolean;
  unread: boolean;
  people: string;
  date: string | null;
  count?: number;
  subject: string;
  snippet: string;
  /** Short account label, shown in All accounts. */
  marker: string | null;
  onSelect: () => void;
  /** Checkbox and star; absent for search hits. */
  check?: { checked: boolean; anyChecked: boolean; onToggle: (range: boolean) => void };
  star?: { flagged: boolean; onToggle: () => void };
}

function Row({
  rowKey,
  selected,
  focused,
  unread,
  people,
  date,
  count,
  subject,
  snippet,
  marker,
  onSelect,
  check,
  star,
}: RowProps) {
  const label = subjectOrPlaceholder(subject);
  return (
    <li
      className={cn(
        "group flex items-start border-b border-border transition-colors hover:bg-state-hover",
        focused && "bg-state-hover",
        (selected || check?.checked) && "bg-state-active hover:bg-state-active",
      )}
    >
      {check !== undefined ? (
        <span className="flex shrink-0 self-stretch items-start pl-3 pt-2.5">
          <Checkbox
            aria-label={`Select ${label}`}
            checked={check.checked}
            onClick={(event) => check.onToggle(event.shiftKey)}
            className={cn(
              "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
              (check.checked || check.anyChecked) && "opacity-100",
            )}
          />
        </span>
      ) : null}
      <button
        type="button"
        data-row-key={rowKey}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 py-2 pr-1 text-left outline-none",
          check === undefined ? "pl-3" : "pl-2",
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
          {marker !== null ? (
            <span className="max-w-24 shrink-0 truncate rounded-sm border border-border px-1 text-xs text-muted-foreground">
              {marker}
            </span>
          ) : null}
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
          {label}
        </span>
        <span className="truncate pl-3.5 text-xs text-muted-foreground">{snippet}</span>
      </button>
      {star !== undefined ? (
        <span className="shrink-0 pr-1.5 pt-1.5">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "size-7",
              star.flagged
                ? "text-primary [&_svg]:fill-current"
                : "text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            )}
            aria-label="Flag conversation"
            aria-pressed={star.flagged}
            onClick={star.onToggle}
          >
            <Icon name="Star" fallback="Check" aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

export interface ThreadListProps {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  /** The account's own address, left out of the participants shown. */
  ownAddress: (accountId: string) => string | null;
  /** The account marker for a row; null outside All accounts. */
  marker: (accountId: string) => string | null;
  onSelect: (thread: ThreadSummary) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Checked conversations. */
  checked: ReadonlySet<string>;
  onToggleChecked: (threadId: string, range: boolean) => void;
  onToggleFlag: (threadId: string) => void;
  focusedId: string | null;
}

export function ThreadList({
  threads,
  selectedThreadId,
  ownAddress,
  marker,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
  checked,
  onToggleChecked,
  onToggleFlag,
  focusedId,
}: ThreadListProps) {
  return (
    <div className="flex flex-col">
      <ul aria-label="Conversations">
        {threads.map((thread) => (
          <Row
            key={thread.id}
            rowKey={thread.id}
            selected={thread.id === selectedThreadId}
            focused={thread.id === focusedId}
            unread={thread.unreadCount > 0}
            people={participantsLabel(thread.participants, ownAddress(thread.accountId))}
            date={thread.lastDate}
            count={thread.messageCount}
            subject={thread.subject}
            snippet={thread.snippet}
            marker={marker(thread.accountId)}
            onSelect={() => onSelect(thread)}
            check={{
              checked: checked.has(thread.id),
              anyChecked: checked.size > 0,
              onToggle: (range) => onToggleChecked(thread.id, range),
            }}
            star={{ flagged: thread.flagged, onToggle: () => onToggleFlag(thread.id) }}
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
  marker: (accountId: string) => string | null;
  onSelect: (hit: MessageSummary) => void;
  focusedId: string | null;
}

export function SearchResultList({ hits, selectedThreadId, marker, onSelect, focusedId }: SearchResultListProps) {
  return (
    <ul aria-label="Search results">
      {hits.map((hit) => (
        <Row
          key={hit.id}
          rowKey={hit.id}
          selected={hit.threadId === selectedThreadId}
          focused={hit.id === focusedId}
          unread={!hit.isRead}
          people={addressLabel(hit.from)}
          date={hit.date}
          subject={hit.subject}
          snippet={hit.snippet}
          marker={marker(hit.accountId)}
          onSelect={() => onSelect(hit)}
        />
      ))}
    </ul>
  );
}
