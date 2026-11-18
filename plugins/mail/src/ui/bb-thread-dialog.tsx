// New thread from a mail (slice 3g, #21): the owner picks a project, what
// to include and an optional instruction; the server answers the exact
// prompt, which shows read-only as plain text with the project's permission
// mode and the hidden-value count. Start sends the same choices the preview
// was built from (the server builds the prompt again); Edit in composer
// opens BB's composer with that prompt.
import { useEffect, useId, useState } from "react";
import type { BbThreadPrepareOutput, SaveResult } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BB_TEXT, errorText, FIELD_CLASS, permissionText, useProjects, type BbCall } from "./bb-ports.ts";
import { ProjectSelect } from "./project-chip.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export interface BbThreadRequest {
  messageId: string;
  /** Preselected: the conversation's project, a link's project or a rule's. */
  projectId: string | null;
  include?: "message" | "conversation";
  /** Prefilled instruction (a rule's template, "Look at <url>"). */
  instruction?: string;
  /** A prepared rule run this start settles. */
  ruleRunId?: string;
  inAiScope: boolean;
  /** The message has attachments: "Also save the attachments" is offered. */
  hasAttachments: boolean;
}

export interface BbThreadDialogProps {
  request: BbThreadRequest | null;
  call: BbCall;
  onStarted: (result: { bbThreadId: string; projectId: string; saved: SaveResult[] }) => void;
  onEditInComposer: (projectId: string, prompt: string) => void;
  onClose: () => void;
}

export function BbThreadDialog(props: BbThreadDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <ThreadBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** "2 hidden values", "3 earlier messages left out". */
export function previewNotes(preview: Pick<BbThreadPrepareOutput, "hidden" | "leftOut">): string[] {
  const notes: string[] = [];
  if (preview.hidden > 0) notes.push(`${preview.hidden} hidden ${preview.hidden === 1 ? "value" : "values"} (passwords, tokens or codes)`);
  if (preview.leftOut > 0) notes.push(`${preview.leftOut} earlier ${preview.leftOut === 1 ? "message" : "messages"} left out`);
  return notes;
}

type Preview =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: BbThreadPrepareOutput }
  | { status: "error"; error: string };

function ThreadBody({ request, call, onStarted, onEditInComposer, onClose }: BbThreadDialogProps & { request: BbThreadRequest }) {
  const { projects } = useProjects(call);
  const instructionId = useId();
  const [projectId, setProjectId] = useState<string | null>(request.projectId);
  const [include, setInclude] = useState<"message" | "conversation">(request.include ?? "message");
  const [instruction, setInstruction] = useState(request.instruction ?? "");
  /** The instruction the preview was built from; Start sends this one. */
  const [applied, setApplied] = useState(request.instruction ?? "");
  const [saveAttachments, setSaveAttachments] = useState(false);
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const project = projects?.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId === null || !request.inAiScope) return;
    let live = true;
    setPreview({ status: "loading" });
    call("bb_thread_prepare", {
      messageId: request.messageId,
      include,
      projectId,
      ...(applied.trim() !== "" ? { instruction: applied } : {}),
      // The preview lists the files Start saves, so it is the prompt Start sends.
      ...(saveAttachments ? { saveAttachments: true } : {}),
    }).then(
      (value) => {
        if (live) setPreview({ status: "ready", value });
      },
      (error: unknown) => {
        if (live) setPreview({ status: "error", error: errorText(error, "The prompt could not be prepared") });
      },
    );
    return () => {
      live = false;
    };
  }, [applied, call, include, projectId, request.inAiScope, request.messageId, saveAttachments]);

  const stale = instruction !== applied;
  const ready = preview.status === "ready" && !stale && projectId !== null && request.inAiScope;
  const start = async () => {
    if (!ready || projectId === null) return;
    setStarting(true);
    setProblem(null);
    try {
      const result = await call("bb_thread_start", {
        messageId: request.messageId,
        include,
        projectId,
        ...(applied.trim() !== "" ? { instruction: applied } : {}),
        ...(saveAttachments ? { saveAttachments: true } : {}),
        ...(request.ruleRunId !== undefined ? { ruleRunId: request.ruleRunId } : {}),
      });
      onStarted({ bbThreadId: result.bbThreadId, projectId, saved: result.saved ?? [] });
      onClose();
    } catch (error) {
      setProblem(errorText(error, "The thread could not be started"));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("New thread from this mail")}</DialogTitle>
        <DialogDescription>
          {tx("The agent starts with the prompt below. The mail inside it is marked as untrusted.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <ProjectSelect label={tx("Project")} projects={projects} value={projectId} onChange={setProjectId} />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-muted-foreground">{tx("Include")}</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(
              [
                ["message", "This message"],
                ["conversation", "The whole conversation"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="bb-thread-include"
                  checked={include === value}
                  onChange={() => setInclude(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={instructionId} className="text-xs font-medium text-muted-foreground">
            {tx("Your instruction (optional)")}
          </label>
          <textarea
            id={instructionId}
            rows={3}
            maxLength={4000}
            className={cn(FIELD_CLASS, "resize-y py-2")}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          {stale ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setApplied(instruction)}>
                {tx("Update the preview")}
              </Button>
              <span className="text-xs text-muted-foreground">{tx("Start sends the prompt shown below.")}</span>
            </div>
          ) : null}
        </div>
        {request.hasAttachments ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={saveAttachments}
              disabled={project !== null && !project.hasTree}
              onCheckedChange={(checked) => setSaveAttachments(checked === true)}
            />
            {tx("Also save the attachments to the project")}
          </label>
        ) : null}
        {project !== null && !project.hasTree && request.hasAttachments ? (
          <p className="text-xs text-muted-foreground">{tx(BB_TEXT.no_tree)}</p>
        ) : null}
        <section aria-label={tx("Prompt preview")} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">{tx("Prompt preview")}</h3>
          {!request.inAiScope ? (
            <p role="note" className="text-sm text-muted-foreground">
              {tx(BB_TEXT.out_of_scope)}
            </p>
          ) : projectId === null ? (
            <p className="text-sm text-muted-foreground">{tx("Choose a project to see the prompt.")}</p>
          ) : preview.status === "loading" || preview.status === "idle" ? (
            <p className="text-sm text-muted-foreground" role="status">
              {tx("Preparing the prompt\u2026")}
            </p>
          ) : preview.status === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {preview.error}
            </p>
          ) : (
            <>
              <pre
                data-testid="bb-thread-prompt"
                className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground"
              >
                {preview.value.prompt}
              </pre>
              <p className="text-xs text-muted-foreground">{tx("Thread title: {title}", { title: preview.value.title })}</p>
              {permissionText(preview.value.permissionMode).map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
              {previewNotes(preview.value).map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </>
          )}
        </section>
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {tx("Cancel")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!ready}
          onClick={() => {
            if (ready && projectId !== null && preview.status === "ready") {
              onEditInComposer(projectId, preview.value.prompt);
              onClose();
            }
          }}
        >
          {tx("Edit in composer")}
        </Button>
        <Button size="sm" disabled={!ready || starting} onClick={() => void start()}>
          {starting ? tx("Starting\u2026") : tx("Start thread")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * A prepared thread as Start sends it (incident and patch dialogs, review
 * C5): the prompt, the title and the permission lines.
 */
export function PreparedPrompt({
  prepared,
  testId,
}: {
  prepared: { prompt: string; title: string; permissionMode: "accept-edits" | "auto" | "full" | null; hidden: number };
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <pre
        data-testid={testId}
        className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground"
      >
        {prepared.prompt}
      </pre>
      <p className="text-xs text-muted-foreground">{tx("Thread title: {title}", { title: prepared.title })}</p>
      {[...permissionText(prepared.permissionMode), ...previewNotes({ hidden: prepared.hidden, leftOut: 0 })].map((line) => (
        <p key={line} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}
