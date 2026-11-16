// Ask (slice 3f): a question about the mail, answered by a model from what
// the plugin found locally. The model plans searches; the plugin runs them
// over mail inside AI access and sends the excerpts. The answer is model
// text; the cited messages are the plugin's own links. Nothing is kept
// after the panel closes.
import { useEffect } from "react";
import type { AiResultView } from "../core/model.ts";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiAction, AiFailure, AiFrame, AiNotesList, AiText, CitationChips, aiLabel, phaseText, type AiCitation } from "./ai-text.tsx";

type AskResult = Extract<AiResultView, { kind: "ask" }>;

export const ASK_QUESTION_MAX = 500;
export const ASK_NOT_FOUND = "Not found in your mail.";

export interface AskPanelProps {
  ports: AiJobPorts;
  question: string;
  /** The chosen account; absent: every account. */
  accountId?: string;
  /** Opens the conversation of a cited message. */
  onOpen: (citation: AiCitation) => void;
  onClose: () => void;
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

export function AskPanel({ ports, question, accountId, onOpen, onClose, pollMs }: AskPanelProps) {
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
        title="Answer"
        label={result !== null ? aiLabel(result.provider, result.model) : "AI answer"}
        caution={result !== null && result.found}
        actions={
          <>
            {state.status === "running" ? <AiAction onClick={job.cancel}>Stop</AiAction> : null}
            <AiAction onClick={onClose}>Close</AiAction>
          </>
        }
      >
        {state.status === "running" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {phaseText(state.phase, "Searching your mail\u2026")}
          </p>
        ) : null}
        {state.status === "failed" ? <AiFailure state={state} /> : null}
        {state.status === "cancelled" ? <p className="text-xs text-muted-foreground">The question was stopped.</p> : null}
        {result !== null && !result.found ? <p className="text-sm text-muted-foreground">{ASK_NOT_FOUND}</p> : null}
        {result !== null && result.found ? (
          <p className="text-sm text-foreground">
            <AiText text={result.answer} />
            <CitationChips numbers={result.sources} citations={result.citations} onCite={onOpen} />
          </p>
        ) : null}
        {sources.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Sources</h3>
            <ul className="flex flex-col gap-1">
              {sources.map((citation) => (
                <li key={citation.n}>
                  <button
                    type="button"
                    onClick={() => onOpen(citation)}
                    className="text-left text-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {`Message ${citation.n}: open the conversation`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {result !== null ? <AiNotesList notes={result.notes} /> : null}
      </AiFrame>
    </div>
  );
}
