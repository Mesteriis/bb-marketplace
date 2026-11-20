// Today (slice 3f): local lists only. Conversations that need a reply (with
// No reply needed), reply reminders that are due, tasks due, and counts of
// what came in since yesterday that link to the filtered Inbox. Summarize
// is the only model call, on the owner's click; each gist shows under its
// row as plain text.
import { openedText } from "./open-line.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { TodayView as TodayData } from "../core/contract.ts";
import type { ReminderView, TaskView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiFailure, AiNotesList, AiText, aiLabel, AI_CAUTION } from "./ai-text.tsx";
import type { Category } from "./category-chips.tsx";
import { daysText } from "./reminder-strip.tsx";
import { LoadingState } from "./empty-states.tsx";
import { addressLabel, formatListDate, participantsLabel, subjectOrPlaceholder } from "./thread-list.tsx";
import { tx } from "./i18n/index.ts";

export interface TodayViewProps {
  load: () => Promise<TodayData>;
  jobs: AiJobPorts;
  /** Why Summarize is off (Makosh AI is missing), or null. */
  aiDisabledReason: string | null;
  onOpen: (accountId: string, threadId: string) => void;
  onNoReply: (threadId: string) => Promise<void>;
  reminderDays: number;
  onReminderSnooze: (reminder: ReminderView, days: number) => Promise<void>;
  onReminderDismiss: (reminder: ReminderView) => Promise<void>;
  onTaskDone: (task: TaskView) => Promise<void>;
  /** The Inbox filtered to a category; absent with categories off. */
  onShowCategory?: (category: Category) => void;
  /** Changes when the page should load again (mail changed). */
  refreshKey?: number;
  pollMs?: number;
  /** Slice 3g: the Dev view; absent: no Dev line. */
  onOpenDev?: () => void;
  /** Slice 3g: the Inbox, where the Ready to start strip is; absent: no rules line. */
  onReviewRules?: () => void;
}

/** "Dev: 2 CI failures in 1 repository \u00b7 1 alert firing", or null when nothing failed or fires. */
export function devLine(dev: TodayData["dev"] | undefined): string | null {
  if (dev === undefined) return null;
  const parts: string[] = [];
  if (dev.ciFailed > 0) {
    parts.push(
      `${dev.ciFailed} CI ${dev.ciFailed === 1 ? "failure" : "failures"} in ${dev.repos} ${dev.repos === 1 ? "repository" : "repositories"}`,
    );
  }
  if (dev.alertsFiring > 0) parts.push(`${dev.alertsFiring} ${dev.alertsFiring === 1 ? "alert" : "alerts"} firing`);
  return parts.length === 0 ? null : tx("Dev: {p1}", { p1: parts.join(" \u00b7 ") });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

const SINCE: readonly { key: Category; one: string; many: string }[] = [
  { key: "notifications", one: "notification", many: "notifications" },
  { key: "newsletters", one: "newsletter", many: "newsletters" },
  { key: "bills", one: "bill", many: "bills" },
  { key: "personal", one: "personal message", many: "personal messages" },
];

export function TodayView(props: TodayViewProps) {
  const { load, refreshKey = 0 } = props;
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (problem) {
      setError(tx(problem instanceof Error && problem.message !== "" ? problem.message : "Today could not be loaded"));
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  const digest = useAiJob(props.jobs, props.pollMs);
  const result = digest.state.status === "done" && digest.state.result.kind === "digest" ? digest.state.result : null;
  const gists = new Map((result?.items ?? []).map((item) => [item.threadId, item.gist]));
  const act = (work: () => Promise<void>) => () => {
    void work().then(reload, () => undefined);
  };

  if (data === null) {
    return error !== null ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <LoadingState label={tx("Loading Today\u2026")} />
    );
  }
  const since = data.since;
  const sinceParts = SINCE.filter(({ key }) => since[key] > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-semibold text-foreground">{tx("Today")}</h1>
        {data.needsReply.length > 0 ? (
          <span title={props.aiDisabledReason ?? undefined} className="inline-flex">
            <Button
              variant="outline"
              size="sm"
              disabled={props.aiDisabledReason !== null || digest.state.status === "running"}
              onClick={() => void digest.run({ kind: "digest" })}
            >
              <Icon name="Sparkles" fallback="Bot" aria-hidden />
              {tx("Summarize")}
            </Button>
          </span>
        ) : null}
      </div>
      {props.onOpenDev !== undefined && devLine(data.dev) !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-foreground">{devLine(data.dev)}</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onOpenDev}>
            {tx("Open Dev")}
          </Button>
        </div>
      ) : null}
      {props.onReviewRules !== undefined && (data.rulesReady ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-foreground">
            {data.rulesReady === 1 ? tx("1 rule thread is ready to start") : `${data.rulesReady} rule threads are ready to start`}
          </span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onReviewRules}>
            {tx("Review")}
          </Button>
        </div>
      ) : null}
      {digest.state.status === "running" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {tx("Summarizing the conversations\u2026")}
        </p>
      ) : null}
      {digest.state.status === "failed" ? <AiFailure state={digest.state} /> : null}
      {result !== null ? (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <p>{aiLabel(result.provider, result.model)}</p>
          <AiNotesList notes={result.notes} />
          <p>{AI_CAUTION}</p>
        </div>
      ) : null}

      <Section title={tx("Needs a reply")}>
        {data.needsReply.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("Nothing waits for your reply.")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.needsReply.map((thread) => (
              <li key={thread.id} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => props.onOpen(thread.accountId, thread.id)}
                    className="flex min-w-0 flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="truncate text-sm text-foreground">{participantsLabel(thread.participants, null)}</span>
                    <span className="truncate text-xs text-muted-foreground">{subjectOrPlaceholder(thread.subject)}</span>
                  </button>
                  {thread.lastDate !== null ? (
                    <time dateTime={thread.lastDate} className="text-xs text-muted-foreground">
                      {formatListDate(thread.lastDate)}
                    </time>
                  ) : null}
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={act(() => props.onNoReply(thread.id))}>
                    {tx("No reply needed")}
                  </Button>
                </div>
                {gists.has(thread.id) ? (
                  <p className="text-sm text-muted-foreground">
                    <AiText text={gists.get(thread.id)!} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {data.opened !== undefined && data.opened.length > 0 ? (
        <Section title={tx("Opened, no reply yet")}>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.opened.map((row) => (
              <li key={`${row.accountId} ${row.threadId}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{row.to !== null ? addressLabel(row.to) : tx("Unknown recipient")}</span>
                  <span className="text-muted-foreground">{` \u00b7 ${subjectOrPlaceholder(row.subject)}`}</span>
                </span>
                <span className="text-xs text-muted-foreground">{openedText(row)}</span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => props.onOpen(row.accountId, row.threadId)}>
                  {tx("Open")}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={tx("Waiting for a reply")}>
        {data.waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("No reminder is due.")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.waiting.map((reminder) => (
              <li key={reminder.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{reminder.recipient !== null ? addressLabel(reminder.recipient) : tx("Unknown recipient")}</span>
                  <span className="text-muted-foreground">{` \u00b7 ${subjectOrPlaceholder(reminder.subject)}`}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={reminder.threadId === null}
                  onClick={() => reminder.threadId !== null && props.onOpen(reminder.accountId, reminder.threadId)}
                >
                  {tx("Open")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={act(() => props.onReminderSnooze(reminder, props.reminderDays))}
                >
                  {tx("Remind in {p1}", { p1: daysText(props.reminderDays) })}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={act(() => props.onReminderDismiss(reminder))}>
                  {tx("Dismiss")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={tx("Tasks due")}>
        {data.tasksDue.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("No task is due.")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.tasksDue.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  <AiText text={task.title} />
                </span>
                {task.due !== null ? <span className="text-xs text-muted-foreground">{task.due}</span> : null}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={act(() => props.onTaskDone(task))}>
                  {tx("Done")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={tx("Since yesterday")}>
        {sinceParts.length === 0 && since.bulk === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("Nothing new from lists or services.")}</p>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
            {sinceParts.map(({ key, one, many }) => {
              const label = `${since[key]} ${since[key] === 1 ? one : many}`;
              return props.onShowCategory !== undefined ? (
                <button
                  key={key}
                  type="button"
                  onClick={() => props.onShowCategory?.(key)}
                  className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {label}
                </button>
              ) : (
                <span key={key}>{label}</span>
              );
            })}
            {since.bulk > 0 ? <span>{`${since.bulk} from mailing lists`}</span> : null}
          </p>
        )}
      </Section>
    </div>
  );
}
