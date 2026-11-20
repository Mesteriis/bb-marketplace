// Write (AI writes mail): the owner says in a few words what the message
// should say and a model writes the body. The text is shown first; nothing
// changes until Insert, which replaces the owner's own text in one editor
// step (one Undo), and only while that text is still what was sent.
import { useId, useState, type FormEvent } from "react";
import type { AiStartInput } from "../core/contract.ts";
import type { AiResultView } from "../core/model.ts";
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
import { tx, txn } from "./i18n/index.ts";

export type WriteInput = Extract<AiStartInput, { kind: "write" }>;
type WriteResult = Extract<AiResultView, { kind: "write" }>;

export const WRITE_REQUEST_MAX = 500;
export const NOT_SAVED_TEXT = "The draft could not be saved; try again.";
export const WRITE_CHANGED_TEXT = "The draft changed while the AI worked. Write it again.";

/** The request as sent: hidden characters removed, one line, at most 500 characters. */
export function cleanRequest(text: string): string {
  return shownText(text).replace(/\s+/g, " ").trim().slice(0, WRITE_REQUEST_MAX);
}

/** The notes under the written text. */
export function writeNotes(result: WriteResult): string[] {
  const notes: string[] = [];
  const { hidden, leftOut } = result.notes;
  if (hidden > 0) notes.push(txn(hidden, "{count} hidden value was not sent to the AI.", "{count} hidden values were not sent to the AI."));
  if (result.linksRemoved > 0) {
    notes.push(txn(result.linksRemoved, "{count} link you did not write was removed.", "{count} links you did not write were removed."));
  }
  if (leftOut > 0) {
    notes.push(txn(leftOut, "{count} message outside AI access was not read.", "{count} messages outside AI access were not read."));
  }
  if (result.unknown > 0) notes.push(tx("The model wrote a hidden value of its own; check it."));
  return notes;
}

export interface WriteDialogProps {
  open: boolean;
  ports: AiJobPorts;
  /** Saves the draft and builds the request; null when the draft could not be saved. */
  prepare: (instruction: string) => Promise<WriteInput | null>;
  /** Replaces the owner's range; false when the text changed since it was sent. */
  onInsert: (paragraphs: string[]) => boolean;
  onClose: () => void;
  pollMs?: number;
}

export function WriteDialog(props: WriteDialogProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.open ? <WriteBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function WriteBody({ ports, prepare, onInsert, onClose, pollMs }: WriteDialogProps) {
  const fieldId = useId();
  const job = useAiJob(ports, pollMs);
  const { run, state } = job;
  const [request, setRequest] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const asked = cleanRequest(request);
  const busy = preparing || state.status === "running";
  const result = state.status === "done" && state.result.kind === "write" ? state.result : null;
  const paragraphs = result === null ? [] : result.paragraphs.map(shownText);

  const write = async () => {
    if (asked === "" || busy) return;
    setProblem(null);
    setPreparing(true);
    try {
      const input = await prepare(asked);
      if (input === null) {
        setProblem(NOT_SAVED_TEXT);
        return;
      }
      void run(input);
    } finally {
      setPreparing(false);
    }
  };
  const insert = () => {
    if (result === null) return;
    if (!onInsert(paragraphs)) {
      setProblem(WRITE_CHANGED_TEXT);
      return;
    }
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void write();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("Write with AI")}</DialogTitle>
        <DialogDescription>
          {result !== null ? aiLabel(result.provider, result.model) : tx("Say in a few words what the message should say; a model writes it in your voice.")}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={fieldId} className="text-xs text-muted-foreground">
            {tx("What should the message say?")}
          </label>
          <Input
            id={fieldId}
            autoFocus
            value={request}
            maxLength={WRITE_REQUEST_MAX}
            placeholder={tx("agree to Tuesday, ask for the agenda")}
            onChange={(event) => setRequest(event.target.value)}
          />
        </div>
        {result === null ? (
          <Button type="submit" disabled={asked === "" || busy}>
            {tx("Write")}
          </Button>
        ) : (
          <Button type="submit" variant="outline" disabled={asked === "" || busy}>
            {tx("Try again")}
          </Button>
        )}
      </form>
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tx("Writing…")}
        </p>
      ) : null}
      {state.status === "failed" ? <AiFailure state={state} /> : null}
      {result !== null ? (
        <div
          aria-label={tx("Written text")}
          className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          {paragraphs.join("\n\n")}
        </div>
      ) : null}
      {result !== null ? (
        <ul aria-label={tx("Notes")} className="flex flex-col text-xs text-muted-foreground">
          {writeNotes(result).map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>{tx("AI can be wrong; read the text before you send it.")}</li>
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {tx(problem)}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tx("Cancel")}
        </Button>
        <Button disabled={result === null || busy || problem !== null} onClick={insert}>
          {tx("Insert")}
        </Button>
      </DialogFooter>
    </>
  );
}
