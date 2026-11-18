// Summarize (slice 3f): the conversation's decisions, open questions and
// deadlines, written by a model on the owner's click, under the subject.
// Every item is model text (plain, pre-wrap) with the plugin's citation
// chips; a stored summary says "cached", and one whose conversation has
// new messages offers Summarize again.
import { useEffect } from "react";
import type { AiResultView } from "../core/model.ts";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiAction, AiFailure, AiFrame, AiNotesList, AiText, CitationChips, aiLabel, phaseText, type AiCitation } from "./ai-text.tsx";
import { tx } from "./i18n/index.ts";

type Summary = Extract<AiResultView, { kind: "summary" }>;

export interface SummaryBlockProps {
  ports: AiJobPorts;
  threadId: string;
  /** The folder viewed (the server reads the conversation there). */
  folder?: string;
  onCite: (citation: AiCitation) => void;
  onClose: () => void;
  pollMs?: number;
}

function Group({
  title,
  items,
  citations,
  onCite,
}: {
  title: string;
  items: readonly { text: string; messages: number[]; date?: string | null }[];
  citations: Summary["citations"];
  onCite: (citation: AiCitation) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
        {items.map((item, index) => (
          <li key={index}>
            {item.date !== undefined && item.date !== null ? (
              <span className="mr-1 text-muted-foreground">
                <AiText text={item.date} />:
              </span>
            ) : null}
            <AiText text={item.text} />
            <CitationChips numbers={item.messages} citations={citations} onCite={onCite} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SummaryBlock({ ports, threadId, folder, onCite, onClose, pollMs }: SummaryBlockProps) {
  const job = useAiJob(ports, pollMs);
  const { run } = job;
  const start = (force: boolean) =>
    void run({ kind: "summary", threadId, ...(folder !== undefined ? { folder } : {}), ...(force ? { force: true } : {}) });
  useEffect(() => {
    start(false);
    // One request per conversation the block opens on.
  }, [threadId]);

  const { state } = job;
  const result = state.status === "done" && state.result.kind === "summary" ? state.result : null;
  const running = state.status === "running";
  const label =
    result !== null
      ? aiLabel(result.provider, result.model, result.cached)
      : state.status === "failed"
        ? aiLabel(state.provider, state.model)
        : tx("AI summary");
  const empty =
    result !== null && result.decisions.length === 0 && result.questions.length === 0 && result.deadlines.length === 0;
  return (
    <AiFrame
      title={tx("Summary")}
      label={label}
      caution={result !== null}
      actions={
        <>
          {running ? (
            <AiAction onClick={job.cancel}>{tx("Stop")}</AiAction>
          ) : (
            <AiAction onClick={() => start(true)}>{tx("Summarize again")}</AiAction>
          )}
          <AiAction onClick={onClose}>{tx("Close")}</AiAction>
        </>
      }
    >
      {running ? (
        <p role="status" className="text-xs text-muted-foreground">
          {phaseText(state.phase === "planning" ? null : state.phase, "Summarizing the conversation\u2026")}
        </p>
      ) : null}
      {state.status === "failed" ? <AiFailure state={state} /> : null}
      {state.status === "cancelled" ? <p className="text-xs text-muted-foreground">{tx("The summary was stopped.")}</p> : null}
      {result !== null && result.stale ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{tx("The conversation has new messages since this summary.")}</span>
        </div>
      ) : null}
      {result !== null ? (
        <>
          <Group title={tx("Decisions")} items={result.decisions} citations={result.citations} onCite={onCite} />
          <Group title={tx("Open questions")} items={result.questions} citations={result.citations} onCite={onCite} />
          <Group title={tx("Deadlines")} items={result.deadlines} citations={result.citations} onCite={onCite} />
          {empty ? <p className="text-sm text-muted-foreground">{tx("Nothing to note in this conversation.")}</p> : null}
          <AiNotesList notes={result.notes} />
        </>
      ) : null}
    </AiFrame>
  );
}
