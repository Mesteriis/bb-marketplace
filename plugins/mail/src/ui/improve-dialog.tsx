// Improve (slice 3f): a model rewrites the owner's own text of a draft (the
// part before the quote and the signature). The answer is shown as a word
// diff over the whole range; nothing changes until Apply, which replaces
// the range in one editor step (one Undo), and only while the text is
// still what was sent.
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AiStartInput } from "../core/contract.ts";
import type { AiResultView } from "../core/model.ts";
import { wordDiff } from "../core/text-diff.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { shownText } from "./agent-send-card.tsx";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiFailure, aiLabel } from "./ai-text.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export type DraftMode = Extract<AiStartInput, { kind: "draft" }>["mode"];
type DraftResult = Extract<AiResultView, { kind: "draft" }>;

export const IMPROVE_MODES: readonly { mode: Exclude<DraftMode, "custom">; label: string }[] = [
  { mode: "fix", label: "Fix mistakes" },
  { mode: "shorter", label: "Shorter" },
  { mode: "formal", label: "More formal" },
  { mode: "friendly", label: "Friendlier" },
];

export const IMPROVE_INSTRUCTION_MAX = 200;
export const DRAFT_CHANGED_TEXT = "The draft changed while the AI worked. Improve it again.";
export const MARKS_NOTICE = "Formatting and links in your text will be removed.";

/** A typed instruction as sent: hidden characters removed, one line, at most 200 characters. */
export function cleanInstruction(text: string): string {
  return shownText(text).replace(/[\r\n]+/g, " ").trim().slice(0, IMPROVE_INSTRUCTION_MAX);
}

/** The notes under the diff. */
export function improveNotes(result: DraftResult, hasMarks: boolean): string[] {
  const notes: string[] = [];
  const hidden = result.notes.hidden;
  if (hidden > 0) notes.push(hidden === 1 ? "1 hidden value kept." : `${hidden} hidden values kept.`);
  if (result.unknown > 0) notes.push("The model changed a hidden value; check it.");
  if (result.missing > 0) notes.push("A hidden value is no longer in the text.");
  if (hasMarks) notes.push(MARKS_NOTICE);
  return notes;
}

/** Improve's choices, shown under the toolbar like the template picker. */
export function ImproveMenu({
  onPick,
  onClose,
}: {
  onPick: (mode: DraftMode, instruction?: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const text = cleanInstruction(instruction);
    if (text !== "") onPick("custom", text);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div
      role="dialog"
      aria-label={tx("Improve")}
      onKeyDown={onKeyDown}
      className="mt-1 flex max-w-sm flex-col gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {IMPROVE_MODES.map(({ mode, label }) => (
        <Button key={mode} type="button" variant="ghost" size="sm" className="h-7 justify-start px-2" onClick={() => onPick(mode)}>
          {label}
        </Button>
      ))}
      <form onSubmit={submit} className="flex items-center gap-1 px-1 pb-1">
        <Input
          id={`${id}-instruction`}
          aria-label={tx("Instruction for the AI")}
          placeholder={tx("Or say how, in one line")}
          value={instruction}
          maxLength={IMPROVE_INSTRUCTION_MAX}
          onChange={(event) => setInstruction(event.target.value)}
          className="h-7 flex-1 text-xs"
        />
        <Button type="submit" variant="outline" size="sm" className="h-7" disabled={cleanInstruction(instruction) === ""}>
          {tx("Go")}
        </Button>
      </form>
    </div>
  );
}

export interface ImproveRequest {
  input: Extract<AiStartInput, { kind: "draft" }>;
  /** The owner's range had marks: Apply drops them. */
  hasMarks: boolean;
}

export interface ImproveDialogProps {
  request: ImproveRequest | null;
  ports: AiJobPorts;
  /** Replaces the owner's range; false when the text changed since it was sent. */
  onApply: (paragraphs: string[]) => boolean;
  onClose: () => void;
  pollMs?: number;
}

export function ImproveDialog(props: ImproveDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <ImproveBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ImproveBody({ request, ports, onApply, onClose, pollMs }: ImproveDialogProps & { request: ImproveRequest }) {
  const job = useAiJob(ports, pollMs);
  const { run, state } = job;
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void run(request.input);
  }, [request, run]);
  const result = state.status === "done" && state.result.kind === "draft" ? state.result : null;
  const before = request.input.paragraphs.join("\n\n");
  const after = result === null ? "" : result.paragraphs.map(shownText).join("\n\n");
  const ops = result === null ? [] : wordDiff(before, after);
  const apply = () => {
    if (result === null) return;
    if (!onApply(result.paragraphs.map(shownText))) {
      setProblem(DRAFT_CHANGED_TEXT);
      return;
    }
    onClose();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("Improve")}</DialogTitle>
        <DialogDescription>
          {result !== null ? aiLabel(result.provider, result.model) : tx("A model rewrites your own text; quotes and the signature stay.")}
        </DialogDescription>
      </DialogHeader>
      {state.status === "running" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tx("Rewriting your text\u2026")}
        </p>
      ) : null}
      {state.status === "failed" ? <AiFailure state={state} /> : null}
      {result !== null ? (
        <div
          aria-label={tx("Changes")}
          className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          {ops.map((op, index) =>
            op.kind === "same" ? (
              <span key={index}>{op.text}</span>
            ) : op.kind === "delete" ? (
              <del key={index} className="bg-destructive/10 text-destructive line-through">
                {op.text}
              </del>
            ) : (
              <ins key={index} className="bg-primary/10 text-foreground no-underline">
                {op.text}
              </ins>
            ),
          )}
        </div>
      ) : null}
      {result !== null ? (
        <ul aria-label={tx("Notes")} className="flex flex-col text-xs text-muted-foreground">
          {improveNotes(result, request.hasMarks).map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>{tx("AI can be wrong; read the text before you send it.")}</li>
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tx("Cancel")}
        </Button>
        <Button disabled={result === null || problem !== null} onClick={apply}>
          {tx("Apply")}
        </Button>
      </DialogFooter>
    </>
  );
}
