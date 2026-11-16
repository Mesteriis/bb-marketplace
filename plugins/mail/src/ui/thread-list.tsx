// The left column: conversations (or search hits) as dense rows, unread in
// bold, and the quick filters above them (slice 3e). Slice 3h: rows drag
// onto rail folders, message rows carry Gmail label chips and the "from the
// server" mark, and a folder's end offers Load more days.
import type { DragEvent, ReactNode } from "react";
import type { AttachmentMatch, MailAddress, MessageSummary, ThreadSummary } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CategoryFilters, RowCategory, categoryLabel, type Category } from "./category-chips.tsx";
import { dragLabel, writeMovePayload } from "./drag-move.ts";
import { LabelChips } from "./label-chips.tsx";

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
export type ListFilter = { unread?: true; flagged?: true; attachments?: true; category?: Category; notDev?: true };

export const LIST_FILTERS: readonly { key: "unread" | "flagged" | "attachments"; label: string }[] = [
  { key: "unread", label: "Unread" },
  { key: "flagged", label: "Flagged" },
  { key: "attachments", label: "Attachments" },
];

/** Whether any toggle is on. */
export function filterActive(filter: ListFilter): boolean {
  return (
    filter.unread === true || filter.flagged === true || filter.attachments === true || filter.category !== undefined || filter.notDev === true
  );
}

/** The empty list's text under the toggles that are on. */
export function filterEmptyText(filter: ListFilter): string {
  if (filter.category !== undefined && !LIST_FILTERS.some(({ key }) => filter[key] === true)) {
    return `No ${categoryLabel(filter.category)} conversations here`;
  }
  const on = LIST_FILTERS.filter(({ key }) => filter[key] === true).map(({ key }) => key);
  if (on.length === 1 && on[0] === "unread") return "No unread conversations here";
  if (on.length === 1 && on[0] === "flagged") return "No flagged conversations here";
  if (on.length === 1 && on[0] === "attachments") return "No conversations with attachments here";
  return "No matching conversations here";
}

/** Unread, Flagged and Attachments: Tab-reachable toggles, no hotkeys. */
export function QuickFilters({
  filter,
  onChange,
  categories = false,
  dev = false,
}: {
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
  /** Slice 3f: the category filters, with categories on. */
  categories?: boolean;
  /** Slice 3g: Hide dev notifications, with devNotifications on. */
  dev?: boolean;
}) {
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
      {dev ? (
        <Button
          variant={filter.notDev === true ? "secondary" : "ghost"}
          size="sm"
          className={cn("h-6 px-2 text-xs", filter.notDev !== true && "text-muted-foreground")}
          aria-pressed={filter.notDev === true}
          onClick={() => {
            const next: ListFilter = { ...filter };
            if (next.notDev === true) delete next.notDev;
            else next.notDev = true;
            onChange(next);
          }}
        >
          Hide dev notifications
        </Button>
      ) : null}
      {categories ? (
        <CategoryFilters
          value={filter.category}
          onChange={(category) => {
            const next: ListFilter = { ...filter };
            if (category === undefined) delete next.category;
            else next.category = category;
            onChange(next);
          }}
        />
      ) : null}
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
  /** Slice 3f: the label or the suggestion. */
  category?: { category: Category | null; suggestion: Category | null };
  onSelect: () => void;
  /** Checkbox and star; absent for search hits. */
  check?: { checked: boolean; anyChecked: boolean; onToggle: (range: boolean) => void };
  star?: { flagged: boolean; onToggle: () => void };
  /** Slice 3h: Gmail label chips (message rows). */
  labels?: readonly string[];
  /** Slice 3h: a server search hit kept outside the window. */
  fromServer?: boolean;
  /** Slice 3h: attachment-text matches of a search hit. */
  matches?: readonly AttachmentMatch[];
  /** Slice 3h: the row drags onto rail folders. */
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
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
  category,
  onSelect,
  check,
  star,
  labels = [],
  fromServer = false,
  matches = [],
  onDragStart,
  onDragEnd,
}: RowProps) {
  const label = subjectOrPlaceholder(subject);
  return (
    <li
      {...(onDragStart !== undefined
        ? { draggable: true, onDragStart, onDragEnd, "aria-describedby": DRAG_HINT_ID }
        : {})}
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
          {category !== undefined ? <RowCategory category={category.category} suggestion={category.suggestion} /> : null}
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
        {labels.length > 0 || fromServer ? (
          <span className="flex min-w-0 items-center gap-1 pl-3.5">
            {fromServer ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                <Icon name="Server" fallback="Mail" className="mr-0.5 inline size-3" aria-hidden />
                from the server
              </span>
            ) : null}
            <LabelChips labels={labels} />
          </span>
        ) : null}
        {matches.map((match, index) => (
          <span key={index} className="truncate pl-3.5 text-xs text-muted-foreground">
            {"in "}
            <span className="italic text-foreground">{match.filename ?? "an attachment"}</span>
            {`: \u2026 ${match.excerpt} \u2026`}
          </span>
        ))}
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
  /** Slice 3f: category chips on the rows (categories on). */
  categories?: boolean;
  /** Slice 3h: rows drag onto rail folders; absent: not draggable. */
  drag?: ListDrag;
  /** Slice 3h: the end of a folder (Load more days); shown after the rows when nothing more is listed. */
  footer?: ReactNode;
}

/** Slice 3h: dragging rows from the list. */
export interface ListDrag {
  /** This page load's id (drag-move.ts). */
  pageId: string;
  /** A drag started with these conversations (the selection when the row is in it). */
  onStart: (threadIds: string[]) => void;
  onEnd: () => void;
}

/** The hint screen readers get on draggable rows; `v` moves without a mouse. */
export const DRAG_HINT_ID = "makosh-mail-drag-hint";

function DragHint() {
  return (
    <span id={DRAG_HINT_ID} className="sr-only">
      Drag onto a folder to move, or press v to move
    </span>
  );
}

/** The conversations a drag of `rowId` carries: the selection when the row is in it. */
export function dragTargets(rowId: string, checked: ReadonlySet<string>): string[] {
  return checked.has(rowId) ? [...checked] : [rowId];
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
  categories = false,
  drag,
  footer = null,
}: ThreadListProps) {
  return (
    <div className="flex flex-col">
      {drag !== undefined ? <DragHint /> : null}
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
            {...(categories ? { category: { category: thread.category, suggestion: thread.categorySuggestion } } : {})}
            onSelect={() => onSelect(thread)}
            check={{
              checked: checked.has(thread.id),
              anyChecked: checked.size > 0,
              onToggle: (range) => onToggleChecked(thread.id, range),
            }}
            star={{ flagged: thread.flagged, onToggle: () => onToggleFlag(thread.id) }}
            {...(drag !== undefined
              ? {
                  onDragStart: (event: DragEvent<HTMLElement>) => {
                    const ids = dragTargets(thread.id, checked);
                    writeMovePayload(event.dataTransfer, drag.pageId, ids);
                    drag.onStart(ids);
                  },
                  onDragEnd: drag.onEnd,
                }
              : {})}
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
      ) : (
        footer
      )}
    </div>
  );
}

export interface SearchResultListProps {
  hits: MessageSummary[];
  selectedThreadId: string | null;
  marker: (accountId: string) => string | null;
  onSelect: (hit: MessageSummary) => void;
  focusedId: string | null;
  /** Slice 3h: hits a server search brought in. */
  serverIds?: ReadonlySet<string>;
  /** Slice 3h: attachment-text matches by message. */
  matches?: readonly AttachmentMatch[];
  /** Slice 3h: the list's name (Search results, or Messages when a folder is not grouped). */
  label?: string;
  /** Slice 3h: Load more. */
  more?: { loading: boolean; onMore: () => void } | null;
}

export function SearchResultList({
  hits,
  selectedThreadId,
  marker,
  onSelect,
  focusedId,
  serverIds,
  matches = [],
  label = "Search results",
  more = null,
}: SearchResultListProps) {
  return (
    <div className="flex flex-col">
    <ul aria-label={label}>
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
          labels={hit.labels ?? []}
          fromServer={serverIds?.has(hit.id) === true || hit.kept === "search"}
          matches={matches.filter((m) => m.messageId === hit.id)}
        />
      ))}
    </ul>
      {more !== null ? (
        <div className="p-3">
          <Button variant="outline" size="sm" className="w-full" disabled={more.loading} onClick={more.onMore}>
            {more.loading ? "Loading\u2026" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Slice 3h: older mail of one folder (history_load). */
export type HistoryState =
  | { kind: "idle"; since: string | null; note: string | null }
  | { kind: "running"; fetched: number; total: number }
  | { kind: "failed"; error: string };

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The end of a folder's list: "Showing mail since ... - Load 30 more days", progress with Stop. */
export function HistoryStrip({
  state,
  stepDays,
  onLoad,
  onStop,
}: {
  state: HistoryState;
  stepDays: number;
  onLoad: () => void;
  onStop: () => void;
}) {
  if (state.kind === "running") {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
        <span>{state.total > 0 ? `Loading\u2026 ${state.fetched} of ~${state.total}` : "Loading\u2026"}</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onStop}>
          Stop
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 px-3 py-3 text-xs text-muted-foreground">
      {state.kind === "failed" ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.kind === "idle" && state.note !== null ? <p>{state.note}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {state.kind === "idle" && state.since !== null ? `Showing mail since ${formatDay(state.since)}` : "Older mail stays on the server"}
        </span>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onLoad}>
          {`Load ${stepDays} more days`}
        </Button>
      </div>
    </div>
  );
}
