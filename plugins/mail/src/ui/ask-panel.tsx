// Ask (slice 3f): a question about the mail, answered by a model from what
// the plugin found locally. The model plans searches; the plugin runs them
// over mail inside AI access and sends the excerpts. The answer is model
// text; the cited messages are the plugin's own links. Nothing is kept
// after the panel closes.
import { useEffect, useState } from "react";
import type { AiResultView, AskActionView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { shownText } from "./agent-send-card.tsx";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiAction, AiFailure, AiFrame, AiNotesList, AiText, CitationChips, aiLabel, phaseText, type AiCitation } from "./ai-text.tsx";
import { tx, txn } from "./i18n/index.ts";

type AskResult = Extract<AiResultView, { kind: "ask" }>;

export const ASK_QUESTION_MAX = 500;
export const ASK_NOT_FOUND = "Not found in your mail.";

/** What runs when the owner presses an action under the answer (Ask AI with actions). */
export interface AskActionPorts {
  /** Puts the query into the search box and runs it. */
  search: (query: string) => void;
  /** Opens a reply to the cited message with the drafted text in it. */
  reply: (action: Extract<AskActionView, { type: "reply" }>) => Promise<void> | void;
  /** Opens a new message with the drafted text in it. */
  compose: (paragraphs: string[]) => Promise<void> | void;
  /** Archive, mark read or flag the cited Inbox messages, with the ordinary Undo. */
  act: (action: Extract<AskActionView, { type: "act" }>) => Promise<void> | void;
}

const DRAFT_PREVIEW = 240;

/** The label of an act button. */
export function actLabel(action: Extract<AskActionView, { type: "act" }>): string {
  switch (action.action) {
    case "archive":
      return txn(action.count, "Archive {count} message", "Archive {count} messages");
    case "mark_read":
      return txn(action.count, "Mark {count} message read", "Mark {count} messages read");
    case "flag":
      return txn(action.count, "Flag {count} message", "Flag {count} messages");
  }
}

function AskActions({ actions, ports }: { actions: readonly AskActionView[]; ports: AskActionPorts }) {
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (index: number, work: () => Promise<void> | void, once: boolean) => {
    if (busy !== null || done.has(index)) return;
    setBusy(index);
    setProblem(null);
    try {
      await work();
      if (once) setDone((prev) => new Set(prev).add(index));
    } catch (error) {
      setProblem(error instanceof Error && error.message !== "" ? error.message : "The action could not be done");
    } finally {
      setBusy(null);
    }
  };
  const preview = (paragraphs: readonly string[]) => {
    const text = shownText(paragraphs.join(" ")).replace(/\s+/g, " ").trim();
    return text.length > DRAFT_PREVIEW ? `${text.slice(0, DRAFT_PREVIEW)}\u2026` : text;
  };
  return (
    <div role="group" aria-label={tx("What you can do next")} className="flex flex-col gap-1.5 border-t border-border pt-2">
      <h3 className="text-xs font-medium text-muted-foreground">{tx("What you can do next")}</h3>
      <ul className="flex flex-col gap-1.5">
        {actions.map((action, index) => {
          const off = busy !== null || done.has(index);
          return (
            <li key={index} className="flex flex-col items-start gap-1">
              {action.type === "search" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-7 max-w-full whitespace-normal break-words text-left"
                  disabled={off}
                  aria-label={`${tx("Show these messages")}: ${shownText(action.query)}`}
                  onClick={() => void run(index, () => ports.search(action.query), false)}
                >
                  {tx("Show these messages")}
                  <span className="ml-1 font-mono text-xs text-muted-foreground">{shownText(action.query)}</span>
                </Button>
              ) : null}
              {action.type === "reply" || action.type === "compose" ? (
                <>
                  <p className="break-words rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground">{preview(action.paragraphs)}</p>
                  {action.linksRemoved > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {txn(action.linksRemoved, "{count} link you did not write was removed.", "{count} links you did not write were removed.")}
                    </p>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={off}
                    onClick={() =>
                      void run(index, () => (action.type === "reply" ? ports.reply(action) : ports.compose(action.paragraphs.map(shownText))), true)
                    }
                  >
                    {action.type === "reply" ? tx("Reply with this") : tx("Write this message")}
                  </Button>
                </>
              ) : null}
              {action.type === "act" ? (
                <Button variant="outline" size="sm" className="h-7" disabled={off} onClick={() => void run(index, () => ports.act(action), true)}>
                  {actLabel(action)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {tx(problem)}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{tx("AI can be wrong; check before you act.")}</p>
    </div>
  );
}

export interface AskPanelProps {
  ports: AiJobPorts;
  question: string;
  /** The chosen account; absent: every account. */
  accountId?: string;
  /** Opens the conversation of a cited message. */
  onOpen: (citation: AiCitation) => void;
  onClose: () => void;
  /** Ask AI with actions: how a proposed action runs; absent: none is offered. */
  actions?: AskActionPorts;
  pollMs?: number;
}

/** The cited sources in the order the answer lists them, unknown numbers left out. */
export function askSources(result: AskResult): AiCitation[] {
  const out: AiCitation[] = [];
  for (const n of result.sources) {
    const citation = result.citations.find((c) => c.n === n);
    if (citation !== undefined && !out.includes(citation)) out.push(citation);
  }
  return out;
}

export function AskPanel({ ports, question, accountId, onOpen, onClose, actions, pollMs }: AskPanelProps) {
  const job = useAiJob(ports, pollMs);
  const { run, state } = job;
  useEffect(() => {
    void run({ kind: "ask", question, ...(accountId !== undefined ? { accountId } : {}) });
  }, [accountId, question, run]);
  const result = state.status === "done" && state.result.kind === "ask" ? state.result : null;
  const sources = result === null ? [] : askSources(result);
  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="text-sm text-foreground">
        <span className="text-muted-foreground">{"Question: "}</span>
        <AiText text={question} />
      </p>
      <AiFrame
        title={tx("Answer")}
        label={result !== null ? aiLabel(result.provider, result.model) : tx("AI answer")}
        caution={result !== null && result.found}
        actions={
          <>
            {state.status === "running" ? <AiAction onClick={job.cancel}>{tx("Stop")}</AiAction> : null}
            <AiAction onClick={onClose}>{tx("Close")}</AiAction>
          </>
        }
      >
        {state.status === "running" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {phaseText(state.phase, "Searching your mail\u2026")}
          </p>
        ) : null}
        {state.status === "failed" ? <AiFailure state={state} /> : null}
        {state.status === "cancelled" ? <p className="text-xs text-muted-foreground">{tx("The question was stopped.")}</p> : null}
        {result !== null && !result.found ? <p className="text-sm text-muted-foreground">{ASK_NOT_FOUND}</p> : null}
        {result !== null && result.found ? (
          <p className="text-sm text-foreground">
            <AiText text={result.answer} />
            <CitationChips numbers={result.sources} citations={result.citations} onCite={onOpen} />
          </p>
        ) : null}
        {sources.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{tx("Sources")}</h3>
            <ul className="flex flex-col gap-1">
              {sources.map((citation) => (
                <li key={citation.n}>
                  <button
                    type="button"
                    onClick={() => onOpen(citation)}
                    className="text-left text-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {tx("Message {n}: open the conversation", { n: citation.n })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {result !== null && result.found && actions !== undefined && (result.actions ?? []).length > 0 ? (
          <AskActions actions={result.actions ?? []} ports={actions} />
        ) : null}
        {result !== null ? <AiNotesList notes={result.notes} /> : null}
      </AiFrame>
    </div>
  );
}
