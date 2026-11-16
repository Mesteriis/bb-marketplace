// A patch in a mail (slice 3g, #78): the card under the message and the
// review dialog. The server parses the patch; the dialog shows each file's
// diff (BB's viewer when injected), the warnings, or why it is refused (then
// no action is offered). Save writes the .patch create-only into the
// project; Apply with an agent uploads it to a new thread in a fresh
// worktree. Mail never applies a patch itself.
import { useEffect, useState } from "react";
import type { PatchViewOutput } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { BB_TEXT, errorText, useProjects, type BbCall, type CodeRenderers } from "./bb-ports.ts";
import { DiffView } from "./code-blocks.tsx";
import { ProjectSelect } from "./project-chip.tsx";
import { stopEscape } from "./shortcuts.ts";

/** "Patch - 3 files - +40 -12". */
export function patchSummaryText(patch: { files: number; added: number; removed: number }): string {
  return `Patch \u00b7 ${patch.files} ${patch.files === 1 ? "file" : "files"} \u00b7 +${patch.added} -${patch.removed}`;
}

export function PatchCard({ patch, onReview }: { patch: { files: number; added: number; removed: number }; onReview: () => void }) {
  return (
    <div role="region" aria-label="Patch" className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
      <Icon name="FileDiff" fallback="Paperclip" className="size-3.5" aria-hidden />
      <span className="min-w-0 flex-1">{patchSummaryText(patch)}</span>
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onReview}>
        Review
      </Button>
    </div>
  );
}

export interface PatchRequest {
  messageId: string;
  partId?: string;
  projectId: string | null;
  inAiScope: boolean;
}

export interface PatchDialogProps {
  request: PatchRequest | null;
  call: BbCall;
  renderers: CodeRenderers;
  onSaved: (path: string, projectName: string) => void;
  onHandedOff: (bbThreadId: string, environment: "worktree" | "checkout") => void;
  onClose: () => void;
}

export function PatchDialog(props: PatchDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <PatchBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Shown before handing the patch to a thread in the project's own checkout. */
export const CHECKOUT_WARNING =
  "BB could not make a separate worktree for this project. In your checkout the agent changes your working files directly, next to anything you have not committed.";

function PatchBody({ request, call, renderers, onSaved, onHandedOff, onClose }: PatchDialogProps & { request: PatchRequest }) {
  const { projects } = useProjects(call);
  const [view, setView] = useState<PatchViewOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(request.projectId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** The worktree was refused: the checkout is offered with a warning. */
  const [offerCheckout, setOfferCheckout] = useState(false);
  const project = projects?.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    let live = true;
    call("patch_view", { messageId: request.messageId, ...(request.partId !== undefined ? { partId: request.partId } : {}) }).then(
      (found) => {
        if (live) setView(found);
      },
      (error: unknown) => {
        if (live) setLoadError(errorText(error, "The patch could not be read"));
      },
    );
    return () => {
      live = false;
    };
  }, [call, request.messageId, request.partId]);

  const base = () => ({
    messageId: request.messageId,
    ...(request.partId !== undefined ? { partId: request.partId } : {}),
  });
  const save = async () => {
    if (view === null || projectId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const { path } = await call("patch_save", { ...base(), projectId, patchRef: view.patchRef });
      setSavedPath(path);
      onSaved(path, project?.name ?? projectId);
    } catch (error) {
      setProblem(errorText(error, "The patch could not be saved"));
    } finally {
      setBusy(false);
    }
  };
  const handOff = async (environment: "worktree" | "checkout") => {
    if (view === null || projectId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await call("patch_handoff", {
        ...base(),
        projectId,
        patchRef: view.patchRef,
        ...(environment === "checkout" ? { environment } : {}),
      });
      onHandedOff(result.bbThreadId, result.environment);
      onClose();
    } catch (error) {
      const text = errorText(error, "The patch could not be handed to an agent");
      if (environment === "worktree" && text === BB_TEXT.no_tree) setOfferCheckout(true);
      else setProblem(text);
    } finally {
      setBusy(false);
    }
  };

  const refused = view?.refused ?? null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Review the patch</DialogTitle>
        <DialogDescription>From an email: treat it as untrusted. Mail never applies it; an agent can, in a new worktree.</DialogDescription>
      </DialogHeader>
      {loadError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : view === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {"Reading the patch\u2026"}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {refused !== null ? (
            <p role="alert" className="text-sm text-destructive">{`Refused: ${refused}`}</p>
          ) : null}
          {view.warnings.length > 0 ? (
            <ul aria-label="Warnings" className="flex flex-col gap-0.5 text-sm text-foreground">
              {view.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-1.5">
                  <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {view.commitMessage !== null && view.commitMessage.trim() !== "" ? (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 text-xs text-muted-foreground">
              {view.commitMessage}
            </pre>
          ) : null}
          <ul aria-label="Files" className="flex flex-col gap-3">
            {view.files.map((file, index) => {
              const path = file.newPath ?? file.oldPath ?? `file ${index + 1}`;
              return (
                <li key={`${path}:${index}`} className="flex min-w-0 flex-col gap-1">
                  <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{path}</span>
                    <span>{file.status}</span>
                    <span>{`+${file.added} -${file.removed}`}</span>
                    {file.binary ? <span>binary</span> : null}
                    {file.executable ? <span>executable</span> : null}
                    {file.symlink ? <span>symlink</span> : null}
                  </p>
                  {file.patch !== "" ? <DiffView patch={file.patch} path={path} renderers={renderers} /> : null}
                </li>
              );
            })}
          </ul>
          {refused === null ? (
            <>
              <ProjectSelect label="Project" projects={projects} value={projectId} onChange={(id) => { setProjectId(id); setOfferCheckout(false); }} />
              {!request.inAiScope ? <p className="text-xs text-muted-foreground">{BB_TEXT.out_of_scope}</p> : null}
              {savedPath !== null ? <p role="status" className="text-xs text-muted-foreground">{`Saved as ${savedPath}`}</p> : null}
              {offerCheckout ? (
                <div role="alert" className="flex flex-col gap-2 rounded-md border border-border p-2 text-sm">
                  <p>{CHECKOUT_WARNING}</p>
                  <div>
                    <Button variant="destructive" size="sm" className="h-7 px-2" disabled={busy} onClick={() => void handOff("checkout")}>
                      Apply in my checkout
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          {problem !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {view !== null && refused === null ? (
          <>
            <span title={project !== null && !project.hasTree ? BB_TEXT.no_tree : undefined} className="inline-flex">
              <Button variant="outline" size="sm" disabled={busy || project === null || !project.hasTree} onClick={() => void save()}>
                Save .patch to project
              </Button>
            </span>
            <span title={request.inAiScope ? undefined : BB_TEXT.out_of_scope} className="inline-flex">
              <Button size="sm" disabled={busy || projectId === null || !request.inAiScope} onClick={() => void handOff("worktree")}>
                Apply with an agent
              </Button>
            </span>
          </>
        ) : null}
      </DialogFooter>
    </>
  );
}
