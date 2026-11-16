// The Mail section of a BB thread's Info tab (slice 3g, #81): the latest
// conversations bound to the thread's project, and those the thread was
// started from. Nothing renders when there are none. Open in Mail and Show
// all go through the page's navigation.
import { useEffect, useState, type ReactNode } from "react";
import type { RpcOut } from "../core/contract.ts";
import type { ThreadSummary } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatListDate, participantsLabel, subjectOrPlaceholder } from "./thread-list.tsx";

export type ThreadMail = RpcOut<"bb_thread_mail">;

export interface ThreadMailSectionProps {
  load: () => Promise<ThreadMail>;
  onOpen: (accountId: string, threadId: string) => void;
  onShowAll: () => void;
  /** The host's section frame, drawn only when there is mail to show. */
  frame?: (content: ReactNode, total: number) => ReactNode;
}

export function ThreadMailSection({ load, onOpen, onShowAll, frame }: ThreadMailSectionProps) {
  const [mail, setMail] = useState<ThreadMail | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (found) => {
        if (live) setMail(found);
      },
      () => {
        if (live) setMail(null);
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (mail === null || (mail.bound.length === 0 && mail.origin.length === 0)) return null;
  const content = (
    <div className="flex flex-col gap-2 text-sm">
      {mail.origin.length > 0 ? <Rows label="Started from" threads={mail.origin} onOpen={onOpen} /> : null}
      {mail.bound.length > 0 ? <Rows label="Bound to this project" threads={mail.bound} onOpen={onOpen} /> : null}
      {mail.total > mail.bound.length ? (
        <div>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onShowAll}>
            {`Show all ${mail.total}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
  return frame !== undefined ? frame(content, mail.total) : content;
}

function Rows({ label, threads, onOpen }: { label: string; threads: readonly ThreadSummary[]; onOpen: ThreadMailSectionProps["onOpen"] }) {
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <ul className="flex flex-col gap-1">
        {threads.map((thread) => (
          <li key={`${thread.accountId}:${thread.id}`} className="flex min-w-0 items-center gap-2">
            {thread.unreadCount > 0 ? <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate text-xs text-foreground", thread.unreadCount > 0 && "font-semibold")}>
                {subjectOrPlaceholder(thread.subject)}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {participantsLabel(thread.participants, null)}
                {thread.lastDate !== null ? ` \u00b7 ${formatListDate(thread.lastDate)}` : ""}
              </span>
            </div>
            <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => onOpen(thread.accountId, thread.id)}>
              Open in Mail
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
