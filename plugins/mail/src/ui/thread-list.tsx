// The left column: conversations (or search hits) as dense rows, unread in
// bold, and the quick filters above them (slice 3e).
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

/**
 * When snoozed mail comes back, short: the weekday and time within the next
 * six days ("Tue 08:00"), else the date and time.
 */
export function formatUntil(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const soon = date.getTime() - now.getTime() < 6 * 86_400_000;
  const day = soon
    ? date.toLocaleDateString(undefined, { weekday: "short" })
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      });
  return `${day} ${time}`;
}

/** The quick filters of a list (slice 3e); `keep` is the page's, not a toggle. */
export type ListFilter = { unread?: true; flagged?: true; attachments?: true };

export const LIST_FILTERS: readonly { key: keyof ListFilter; label: string }[] = [
  { key: "unread", label: "Unread" },
  { key: "flagged", label: "Flagged" },
  { key: "attachments", label: "Attachments" },
];

/** Whether any toggle is on. */
export function filterActive(filter: ListFilter): boolean {
  return filter.unread === true || filter.flagged === true || filter.attachments === true;
}

/** The empty list's text under the toggles that are on. */
export function filterEmptyText(filter: ListFilter): string {
  const on = LIST_FILTERS.filter(({ key }) => filter[key] === true).map(({ key }) => key);
  if (on.length === 1 && on[0] === "unread") return "No unread conversations here";
  if (on.length === 1 && on[0] === "flagged") return "No flagged conversations here";
  if (on.length === 1 && on[0] === "attachments") return "No conversations with attachments here";
  return "No matching conversations here";
}

/** Unread, Flagged and Attachments: Tab-reachable toggles, no hotkeys. */
export function QuickFilters({ filter, onChange }: { filter: ListFilter; onChange: (next: ListFilter) => void }) {
  return (
    <div role="group" aria-label="Quick filters" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1">
      {LIST_FILTERS.map(({ key, label }) => {
        const on = filter[key] === true;
        return (
          <Button
            key={key}
            variant={on ? "secondary" : "ghost"}
            size="sm"
            className={cn("h-6 px-2 text-xs", !on && "text-muted-foreground")}
            aria-pressed={on}
            onClick={() => {
              const next: ListFilter = { ...filter };
              if (on) delete next[key];
              else next[key] = true;
              onChange(next);
            }}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

/** The list under the toggles is empty: say so, with Clear filters. */
export function FilteredEmpty({ filter, onClear }: { filter: ListFilter; onClear: () => void }) {
  return (
    <div role="status" className="flex flex-col items-start gap-2 px-3 py-4">
      <p className="text-sm text-muted-foreground">{filterEmptyText(filter)}</p>
      <Button variant="outline" size="sm" className="h-7" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
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
  /** When a snoozed conversation comes back (slice 3e). */
  snoozedUntil?: string | null;
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
  snoozedUntil = null,
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
        {snoozedUntil !== null ? (
          <span className="flex items-center gap-1 pl-3.5 text-xs text-muted-foreground">
            <Icon name="Clock" fallback="Info" className="size-3" aria-hidden />
            until {formatUntil(snoozedUntil)}
          </span>
        ) : null}
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
            snoozedUntil={thread.snoozedUntil}
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
