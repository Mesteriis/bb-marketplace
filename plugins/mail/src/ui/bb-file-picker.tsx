// Attach files from BB (slice 3g, #56): a project's files, or a thread's
// storage files (the thread Mail runs beside, or a recent thread of a
// project), up to 10 ticks. The server reads and attaches them; a name that
// looks like it holds a secret needs a second confirmation.
import { useEffect, useId, useState } from "react";
import type { ComposeAttachment } from "../core/model.ts";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BB_TEXT, errorText, FIELD_CLASS, useProjects, type BbCall } from "./bb-ports.ts";
import { ProjectSelect } from "./project-chip.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

/** Most files one pick attaches. */
export const PICK_MAX = 10;

export interface FilePickRequest {
  kind: "project" | "thread";
  draftId: string;
}

export interface BbFilePickerProps {
  request: FilePickRequest | null;
  call: BbCall;
  /** BB's current project and thread (useBbContext), when Mail runs beside one. */
  currentProjectId: string | null;
  currentThreadId: string | null;
  onAttached: (attachments: ComposeAttachment[]) => void;
  onClose: () => void;
}

export function BbFilePicker(props: BbFilePickerProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <PickerBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

type Entry = { name: string; path: string };
type Source = { kind: "project"; projectId: string; path: string } | { kind: "thread"; bbThreadId: string; path: string };

function PickerBody({ request, call, currentProjectId, currentThreadId, onAttached, onClose }: BbFilePickerProps & { request: FilePickRequest }) {
  const { projects } = useProjects(call);
  const ids = { search: useId(), thread: useId() };
  const [projectId, setProjectId] = useState<string | null>(currentProjectId);
  const [threads, setThreads] = useState<{ id: string; title: string }[] | null>(null);
  const [threadId, setThreadId] = useState<string | null>(request.kind === "thread" ? currentThreadId : null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<{ entries: Entry[]; truncated: boolean } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ sources: Source[]; done: ComposeAttachment[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const useCurrentThread = request.kind === "thread" && currentThreadId !== null && threadId === currentThreadId;

  // From a thread without a current one: a recent thread of the chosen project.
  useEffect(() => {
    if (request.kind !== "thread" || projectId === null || useCurrentThread) return;
    let live = true;
    call("bb_threads_recent", { projectId, limit: 30 }).then(
      ({ threads: found }) => {
        if (live) setThreads(found);
      },
      () => {
        if (live) setThreads([]);
      },
    );
    return () => {
      live = false;
    };
  }, [call, projectId, request.kind, useCurrentThread]);
  useEffect(() => {
    const source = request.kind === "project" ? projectId : threadId;
    if (source === null) return;
    let live = true;
    const load =
      request.kind === "project"
        ? call("project_files", { projectId: source, query, limit: 50 })
        : call("thread_files", { bbThreadId: source, query, limit: 50 });
    load.then(
      (found) => {
        if (live) setFiles({ entries: found.files, truncated: found.truncated });
      },
      (error: unknown) => {
        if (live) {
          setFiles({ entries: [], truncated: false });
          setProblem(errorText(error, "BB did not list the files"));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [call, projectId, query, request.kind, threadId]);

  const sourceOf = (path: string): Source | null =>
    request.kind === "project"
      ? projectId === null
        ? null
        : { kind: "project", projectId, path }
      : threadId === null
        ? null
        : { kind: "thread", bbThreadId: threadId, path };
  const attach = async (sources: Source[], confirmed: boolean, done: ComposeAttachment[]) => {
    setBusy(true);
    setProblem(null);
    const attached = [...done];
    const ask: Source[] = [];
    try {
      for (const source of sources) {
        try {
          attached.push(
            await call("compose_attach_bb", { draftId: request.draftId, source, ...(confirmed ? { confirmed: true } : {}) }),
          );
        } catch (error) {
          if (!confirmed && errorText(error, "") === BB_TEXT.confirm_needed) ask.push(source);
          else throw error;
        }
      }
      if (ask.length > 0) {
        setConfirm({ sources: ask, done: attached });
        return;
      }
      onAttached(attached);
      onClose();
    } catch (error) {
      if (attached.length > done.length) onAttached(attached);
      setProblem(errorText(error, "The file could not be attached"));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (path: string, on: boolean) =>
    setPicked((prev) => (on ? (prev.length >= PICK_MAX || prev.includes(path) ? prev : [...prev, path]) : prev.filter((p) => p !== path)));

  if (confirm !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tx("Attach anyway?")}</DialogTitle>
          <DialogDescription>
            {confirm.sources.length === 1
              ? `The name ${baseName(confirm.sources[0]!.path)} looks like it holds a password, key or token.`
              : `${confirm.sources.length} names look like they hold a password, key or token.`}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {confirm.sources.map((source) => (
            <li key={source.path} className="truncate">
              {source.path}
            </li>
          ))}
        </ul>
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm.done.length > 0) onAttached(confirm.done);
              onClose();
            }}
          >
            {tx("Leave them out")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void attach(confirm.sources, true, confirm.done)}>
            {tx("Attach anyway")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{request.kind === "project" ? tx("Attach from a project") : tx("Attach from a thread")}</DialogTitle>
        <DialogDescription>{`Tick up to ${PICK_MAX} files. They are sent as they are; nothing is hidden in them.`}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        {request.kind === "thread" && currentThreadId !== null ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={useCurrentThread}
              onCheckedChange={(checked) => {
                setThreadId(checked === true ? currentThreadId : null);
                setFiles(null);
                setPicked([]);
              }}
            />
            {tx("The thread Mail is open beside")}
          </label>
        ) : null}
        {!useCurrentThread ? (
          <ProjectSelect
            label={tx("Project")}
            projects={projects}
            value={projectId}
            onChange={(id) => {
              setProjectId(id);
              if (request.kind === "thread") setThreadId(null);
              setFiles(null);
              setPicked([]);
            }}
          />
        ) : null}
        {request.kind === "thread" && !useCurrentThread && projectId !== null ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.thread} className="text-xs font-medium text-muted-foreground">
              {tx("Thread")}
            </label>
            <select
              id={ids.thread}
              className={cn(FIELD_CLASS, "h-8")}
              value={threadId ?? ""}
              onChange={(e) => {
                setThreadId(e.target.value === "" ? null : e.target.value);
                setFiles(null);
                setPicked([]);
              }}
            >
              <option value="" disabled>
                {threads === null ? tx("Loading threads\u2026") : threads.length === 0 ? tx("No recent threads") : tx("Choose a thread")}
              </option>
              {(threads ?? []).map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.search} className="text-xs font-medium text-muted-foreground">
            {tx("Search")}
          </label>
          <Input id={ids.search} value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {files === null ? null : files.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("No files.")}</p>
        ) : (
          <ul aria-label={tx("Files")} className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {files.entries.map((entry) => {
              const on = picked.includes(entry.path);
              return (
                <li key={entry.path}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={entry.path}
                      checked={on}
                      disabled={!on && picked.length >= PICK_MAX}
                      onCheckedChange={(checked) => toggle(entry.path, checked === true)}
                    />
                    <span className="min-w-0 truncate font-mono text-xs">{entry.path}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {files?.truncated === true ? <p className="text-xs text-muted-foreground">{tx("More files match; search to narrow.")}</p> : null}
        <p className="text-xs text-muted-foreground" role="status">{`${picked.length} of ${PICK_MAX} picked`}</p>
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
          size="sm"
          disabled={busy || picked.length === 0}
          onClick={() => {
            const sources = picked.map(sourceOf).filter((s): s is Source => s !== null);
            void attach(sources, false, []);
          }}
        >
          {tx("Attach")}
        </Button>
      </DialogFooter>
    </>
  );
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
