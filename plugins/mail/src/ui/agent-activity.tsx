// Agent activity (slice 3f): the local action log, newest first. The log
// holds ids, counts and codes only; the subjects and senders shown here are
// what Makosh Mail holds now (resolved when the page asks), and a message
// that left shows as gone. Commands the owner runs in a terminal outside a
// BB thread are not logged.
import { useCallback, useEffect, useState } from "react";
import type { LogEntryView } from "../core/model.ts";
import type { LogActor, LogOutcome, LogTool } from "../core/agent-log.ts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { subjectOrPlaceholder } from "./thread-list.tsx";
import { dateLocale, msg, tx } from "./i18n/index.ts";

export const LOG_PAGE = 50;
export const TERMINAL_NOT_LOGGED = msg("Commands in your own terminal are not logged.");
export const MESSAGE_GONE = "no longer in Makosh Mail";
const ALL_THREADS = "all";

const ACTORS: Record<LogActor, string> = {
  agent: msg("Agent"),
  mention: msg("Mention"),
  handoff: msg("Hand to agent"),
  cli: msg("Command in a thread"),
  owner_ai: msg("You (AI)"),
  owner_bb: msg("You (BB)"),
  rule: msg("Mail rule"),
};

const TOOLS: Record<LogTool, string> = {
  search: msg("Searched mail"),
  read: msg("Read an email"),
  contacts: msg("Looked up contacts"),
  inbox: msg("Listed the inbox"),
  propose: msg("Proposed an email"),
  templates: msg("Read templates"),
  triage: msg("Proposed inbox actions"),
  mention: msg("Mentioned an email"),
  handoff: msg("Handed an email over"),
  cli_search: msg("Searched mail (command)"),
  cli_read: msg("Read an email (command)"),
  ai_translate: msg("Translation"),
  ai_summary: msg("Summary"),
  ai_ask: msg("Ask"),
  ai_tasks: msg("Find tasks"),
  ai_categories: msg("Suggested categories"),
  ai_digest: msg("Today summary"),
  ai_draft: msg("Improve"),
  bb_thread: msg("BB thread"),
  bb_task: msg("Task"),
  project_save: msg("Saved to a project"),
  patch_handoff: msg("Patch to an agent"),
  incident: msg("Incident thread"),
  rule_thread: msg("Rule thread"),
};

const OUTCOMES: Record<LogOutcome, string> = {
  ok: "done",
  empty: "nothing found",
  refused_off: "refused: off in settings",
  refused_scope: "refused: outside AI access",
  refused_invalid: "refused: not valid",
  refused_caps: "refused: too many requests",
  proposed: "waiting for you",
  sent: "sent",
  opened: "opened in the composer",
  cancelled: "cancelled",
  expired: "expired",
  applied: "applied",
  failed: "failed",
  prepared: "ready to start",
  started: "started",
  capped: "held: limit reached",
};

/** "Today 10:42", "Yesterday 18:03" or "12 Nov 09:15", in local time. */
export function logTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(date) === day(now)) return tx("Today {time}", { time });
  if (day(date) === day(yesterday)) return tx("Yesterday {time}", { time });
  return `${date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })} ${time}`;
}

/** One row's line, without the messages. */
export function logLine(entry: LogEntryView, now?: Date): string {
  const parts = [logTime(entry.at, now), tx(ACTORS[entry.actor]), tx(TOOLS[entry.tool]), tx(OUTCOMES[entry.outcome])];
  if (entry.count > 0) parts.push(entry.count === 1 ? "1 item" : `${entry.count} items`);
  if (entry.hiddenCount > 0) parts.push(entry.hiddenCount === 1 ? "1 hidden value" : `${entry.hiddenCount} hidden values`);
  if (entry.model !== null && entry.model !== "") parts.push(entry.model);
  else if (entry.provider !== null && entry.provider !== "") parts.push(entry.provider);
  return parts.filter((p) => p !== "").join(" \u00b7 ");
}

export interface AgentActivityProps {
  load: (input: { threadId?: string; cursor: string | null }) => Promise<{ entries: LogEntryView[]; next: string | null }>;
  clear: () => Promise<number>;
  onOpen: (accountId: string, threadId: string) => void;
}

export function AgentActivity({ load, clear, onOpen }: AgentActivityProps) {
  const [thread, setThread] = useState<string>(ALL_THREADS);
  const [entries, setEntries] = useState<LogEntryView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [threads, setThreads] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(async () => {
    try {
      const page = await load({ ...(thread !== ALL_THREADS ? { threadId: thread } : {}), cursor: null });
      setEntries(page.entries);
      setNext(page.next);
      setProblem(null);
      if (thread === ALL_THREADS) {
        setThreads([...new Set(page.entries.map((e) => e.threadId).filter((id): id is string => id !== null))]);
      }
    } catch (error) {
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "Agent activity could not be loaded"));
    }
  }, [load, thread]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const more = async () => {
    if (next === null) return;
    try {
      const page = await load({ ...(thread !== ALL_THREADS ? { threadId: thread } : {}), cursor: next });
      setEntries((prev) => [...(prev ?? []), ...page.entries]);
      setNext(page.next);
    } catch {
      // The list keeps what it has.
    }
  };
  const doClear = async () => {
    setConfirming(false);
    try {
      await clear();
      setThread(ALL_THREADS);
      await reload();
    } catch (error) {
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The log could not be cleared"));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {tx("What agents and AI features did with your mail, kept on this computer for 90 days. The log keeps ids and counts, never a query, subject or text.")} {tx(TERMINAL_NOT_LOGGED)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={thread} onValueChange={setThread}>
          <SelectTrigger aria-label={tx("Thread")} className="h-8 w-auto max-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_THREADS}>{tx("Every thread")}</SelectItem>
            {threads.map((id) => (
              <SelectItem key={id} value={id}>
                {tx("Thread {p1}", { p1: id.slice(0, 8) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-1" />
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">{tx("Clear the whole log?")}</span>
            <Button variant="destructive" size="sm" onClick={() => void doClear()}>
              {tx("Clear log")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {tx("Cancel")}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" disabled={entries === null || entries.length === 0} onClick={() => setConfirming(true)}>
            {tx("Clear log\u2026")}
          </Button>
        )}
      </div>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {entries === null ? null : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("Nothing yet.")}</p>
      ) : (
        <ul aria-label={tx("Agent activity")} className="flex flex-col divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.seq} className="flex flex-col gap-0.5 py-2">
              <p className="text-sm text-foreground">{logLine(entry)}</p>
              {entry.messages.length > 0 ? (
                <ul className="flex flex-col gap-0.5 pl-3">
                  {entry.messages.slice(0, 5).map((message) => (
                    <li key={message.id} className="text-xs text-muted-foreground">
                      {message.subject === null || message.accountId === null || message.threadId === null ? (
                        MESSAGE_GONE
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpen(message.accountId!, message.threadId!)}
                          className="text-left underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          {`${subjectOrPlaceholder(message.subject)}${message.from !== null ? ` \u00b7 ${message.from}` : ""}`}
                        </button>
                      )}
                    </li>
                  ))}
                  {entry.messages.length > 5 ? (
                    <li className="text-xs text-muted-foreground">{`and ${entry.messages.length - 5} more`}</li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {next !== null ? (
        <Button variant="outline" size="sm" onClick={() => void more()}>
          {tx("Load more")}
        </Button>
      ) : null}
    </div>
  );
}
