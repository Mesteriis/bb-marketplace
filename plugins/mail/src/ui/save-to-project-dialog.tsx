// Save attachments into a BB project (slice 3g, #57): project, folder
// inside its working tree, then the server writes create-only. A name that
// exists comes back as "exists" and the owner chooses: Keep both (the
// default, a numbered name), Replace (a second confirmation, and only the
// file the dialog showed: its sha256 goes with the call) or Cancel.
import { useEffect, useId, useState } from "react";
import type { SaveResult } from "../core/contract.ts";
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
import { errorText, projectName, useProjects, type BbCall } from "./bb-ports.ts";
import { ProjectSelect } from "./project-chip.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export interface SaveRequest {
  messageId: string;
  parts: { partId: string; name: string }[];
  /** Preselected project (the conversation's). */
  projectId: string | null;
}

export interface SaveToProjectDialogProps {
  request: SaveRequest | null;
  call: BbCall;
  /** attachmentFolder as BB has it. */
  defaultFolder: string;
  onSaved: (results: SaveResult[], projectName: string) => void;
  onClose: () => void;
}

export function SaveToProjectDialog(props: SaveToProjectDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <SaveBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

type Exists = Extract<SaveResult, { outcome: "exists" }>;
type Step = { kind: "choose" } | { kind: "conflict"; exists: Exists[] } | { kind: "replace"; exists: Exists[] } | { kind: "done" };

/** Results of a later call replace the earlier ones of the same part. */
export function mergeResults(previous: readonly SaveResult[], next: readonly SaveResult[]): SaveResult[] {
  const byPart = new Map(previous.map((r) => [r.partId, r]));
  for (const result of next) byPart.set(result.partId, result);
  return [...byPart.values()];
}

function SaveBody({ request, call, defaultFolder, onSaved, onClose }: SaveToProjectDialogProps & { request: SaveRequest }) {
  const { projects } = useProjects(call);
  const folderId = useId();
  const listId = useId();
  const [projectId, setProjectId] = useState<string | null>(request.projectId);
  const [folder, setFolder] = useState(defaultFolder);
  const [folders, setFolders] = useState<string[]>([]);
  const [results, setResults] = useState<SaveResult[]>([]);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const canSave = project !== null && project.hasTree && folder.trim() !== "";

  // A project picked whose tree is unknown or missing is never preselected.
  useEffect(() => {
    if (projects !== null && projectId !== null && projects.find((p) => p.id === projectId)?.hasTree !== true) setProjectId(null);
  }, [projectId, projects]);
  useEffect(() => {
    if (project === null || !project.hasTree) return;
    let live = true;
    call("project_folders", { projectId: project.id, query: "", limit: 50 }).then(
      ({ folders: found }) => {
        if (live) setFolders(found.map((f) => f.path));
      },
      () => {
        if (live) setFolders([]);
      },
    );
    return () => {
      live = false;
    };
  }, [call, project]);

  const run = async (input: { partIds: string[]; onConflict: "ask" | "keep_both" | "replace"; replaceSha?: string }) => {
    if (projectId === null) return [];
    const { results: got } = await call("attachment_save", {
      messageId: request.messageId,
      projectId,
      folder: folder.trim(),
      ...input,
    });
    return got;
  };
  const settle = (all: SaveResult[]) => {
    setResults(all);
    const exists = all.filter((r): r is Exists => r.outcome === "exists");
    if (exists.length > 0) {
      setStep({ kind: "conflict", exists });
      return;
    }
    setStep({ kind: "done" });
    onSaved(all, projectId === null ? "" : projectName(projects, projectId));
  };
  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(errorText(error, "The attachments could not be saved"));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    guarded(async () => settle(await run({ partIds: request.parts.map((p) => p.partId), onConflict: "ask" })));
  const keepBoth = (exists: Exists[]) =>
    guarded(async () => settle(mergeResults(results, await run({ partIds: exists.map((e) => e.partId), onConflict: "keep_both" }))));
  const replace = (exists: Exists[]) =>
    guarded(async () => {
      let all = results;
      for (const file of exists) {
        all = mergeResults(all, await run({ partIds: [file.partId], onConflict: "replace", replaceSha: file.currentSha }));
      }
      settle(all);
    });
  const cancelConflicts = (exists: Exists[]) => {
    const skipped = new Set(exists.map((e) => e.partId));
    const kept = results.filter((r) => !skipped.has(r.partId));
    setResults(kept);
    setStep({ kind: "done" });
    if (kept.length > 0) onSaved(kept, projectId === null ? "" : projectName(projects, projectId));
  };
  const nameOf = (partId: string) => request.parts.find((p) => p.partId === partId)?.name ?? partId;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{request.parts.length === 1 ? tx("Save to project") : `Save ${request.parts.length} attachments to project`}</DialogTitle>
        <DialogDescription>
          {tx("Saved inside the project's folder. Mail never opens or runs a saved file, and never overwrites one without asking.")}
        </DialogDescription>
      </DialogHeader>
      {step.kind === "choose" ? (
        <div className="flex flex-col gap-3">
          <ul aria-label={tx("Files to save")} className="flex flex-col gap-0.5 text-sm text-foreground">
            {request.parts.map((part) => (
              <li key={part.partId} className="truncate">
                {part.name}
              </li>
            ))}
          </ul>
          <ProjectSelect label={tx("Project")} projects={projects} value={projectId} onChange={setProjectId} requireTree />
          <div className="flex flex-col gap-1">
            <label htmlFor={folderId} className="text-xs font-medium text-muted-foreground">
              {tx("Folder in the project")}
            </label>
            <Input id={folderId} list={listId} value={folder} maxLength={240} onChange={(e) => setFolder(e.target.value)} />
            <datalist id={listId}>
              {folders.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              {tx("Relative to the project; no folder that starts with a dot. Agent instruction and shortcut names are saved with .txt.")}
            </p>
          </div>
        </div>
      ) : step.kind === "conflict" ? (
        <div role="group" aria-label={tx("Files that exist")} className="flex flex-col gap-2 text-sm">
          <p>{step.exists.length === 1 ? tx("A file with this name is already there:") : tx("Files with these names are already there:")}</p>
          <ul className="flex flex-col gap-0.5">
            {step.exists.map((file) => (
              <li key={file.partId} className="truncate font-mono text-xs">
                {file.path}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{tx("Keep both saves a numbered copy beside it.")}</p>
        </div>
      ) : step.kind === "replace" ? (
        <div role="alert" className="flex flex-col gap-2 text-sm">
          <p>
            {step.exists.length === 1
              ? `Replace ${step.exists[0]!.path}? The file in the project is overwritten.`
              : `Replace ${step.exists.length} files? The files in the project are overwritten.`}
          </p>
          <p className="text-xs text-muted-foreground">{tx("If the file changed since, Mail does not replace it.")}</p>
        </div>
      ) : (
        <ul aria-label={tx("Saved files")} className="flex flex-col gap-1 text-sm">
          {results.map((result) => (
            <li key={result.partId} className="flex flex-col">
              <span className="truncate text-foreground">{nameOf(result.partId)}</span>
              <span className={result.outcome === "failed" ? "text-xs text-destructive" : "truncate font-mono text-xs text-muted-foreground"}>
                {result.outcome === "saved"
                  ? `Saved as ${result.path}`
                  : result.outcome === "exists"
                    ? `Not saved: ${result.path} exists`
                    : `Not saved: ${result.reason}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        {step.kind === "choose" ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {tx("Cancel")}
            </Button>
            <Button size="sm" disabled={!canSave || busy} onClick={() => void save()}>
              {tx("Save")}
            </Button>
          </>
        ) : step.kind === "conflict" ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => cancelConflicts(step.exists)}>
              {tx("Cancel")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setStep({ kind: "replace", exists: step.exists })}>
              {tx("Replace\u2026")}
            </Button>
            <Button size="sm" autoFocus disabled={busy} onClick={() => void keepBoth(step.exists)}>
              {tx("Keep both")}
            </Button>
          </>
        ) : step.kind === "replace" ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep({ kind: "conflict", exists: step.exists })}>
              {tx("Back")}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void replace(step.exists)}>
              {tx("Replace")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onClose}>
            {tx("Done")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
