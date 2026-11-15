// The sidebar's conversation list: the merged Inbox of every account as dense
// rows in place of BB's chat list. Opening a row goes to the Mail page.
import type { ThreadSummary } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatListDate, participantsLabel, subjectOrPlaceholder } from "./thread-list.tsx";

export interface SidebarMailListProps {
  threads: ThreadSummary[];
  /** The first page is loading. */
  loading: boolean;
  error: string | null;
  /** Mail is not set up yet (no key or no account): nothing to list. */
  noAccounts: boolean;
  /** The conversation the Mail page shows, highlighted here. */
  activeThreadId: string | null;
  /** The account's own address, left out of the people shown. */
  ownAddress: (accountId: string) => string | null;
  /** A short account label; null when there is only one account. */
  marker: (accountId: string) => string | null;
  onOpen: (thread: ThreadSummary) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenMail: () => void;
  onAddAccount: () => void;
}

function Notice({ children, role = "status" }: { children: string; role?: "status" | "alert" }) {
  return (
    <p role={role} className="px-3 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function Row({
  thread,
  active,
  people,
  marker,
  onOpen,
}: {
  thread: ThreadSummary;
  active: boolean;
  people: string;
  marker: string | null;
  onOpen: () => void;
}) {
  const unread = thread.unreadCount > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
          active && "bg-state-active hover:bg-state-active",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 self-center rounded-full", unread ? "bg-primary" : "bg-transparent")}
          />
          <span className={cn("min-w-0 flex-1 truncate text-sm text-foreground", unread && "font-semibold")}>
            {people}
          </span>
          {marker !== null ? (
            <span className="max-w-16 shrink-0 truncate text-xs text-muted-foreground">{marker}</span>
          ) : null}
          {thread.lastDate !== null ? (
            <time dateTime={thread.lastDate} className="shrink-0 text-xs text-muted-foreground">
              {formatListDate(thread.lastDate)}
            </time>
          ) : null}
        </span>
        <span className="truncate pl-3 text-xs text-muted-foreground">
          {unread ? <span className="sr-only">Unread: </span> : null}
          {subjectOrPlaceholder(thread.subject)}
        </span>
      </button>
    </li>
  );
}

export function SidebarMailList(props: SidebarMailListProps) {
  const { threads } = props;
  const body = (() => {
    if (props.noAccounts) {
      return (
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          <p className="text-xs text-muted-foreground">No mail account yet.</p>
          <Button variant="outline" size="sm" onClick={props.onAddAccount}>
            Add a mail account
          </Button>
        </div>
      );
    }
    if (props.loading && threads.length === 0) return <Notice>Loading mail…</Notice>;
    if (props.error !== null && threads.length === 0) {
      return <Notice role="alert">{`Could not load mail: ${props.error}`}</Notice>;
    }
    if (threads.length === 0) return <Notice>Inbox is empty</Notice>;
    return (
      <>
        <ul aria-label="Inbox conversations" className="flex flex-col gap-px px-1">
          {threads.map((thread) => (
            <Row
              key={`${thread.accountId}:${thread.id}`}
              thread={thread}
              active={thread.id === props.activeThreadId}
              people={participantsLabel(thread.participants, props.ownAddress(thread.accountId))}
              marker={props.marker(thread.accountId)}
              onOpen={() => props.onOpen(thread)}
            />
          ))}
        </ul>
        {props.hasMore ? (
          <div className="px-2 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
            >
              {props.loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </>
    );
  })();
  return (
    <div className="flex min-w-0 flex-col pb-2">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
        <span className="truncate text-xs font-medium text-muted-foreground">Inbox · All accounts</span>
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={props.onOpenMail}>
          Open Mail
        </Button>
      </div>
      {body}
    </div>
  );
}
