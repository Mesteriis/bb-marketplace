// Projects (slice 3g, #81): the conversations bound to a BB project (by the
// owner or by a binding rule), newest first, paged; without a project
// chosen, the projects that have bindings. Subjects here are the owner's
// own view, never agent text.
import { useCallback, useEffect, useState } from "react";
import type { BindingView, ProjectListItem } from "../core/contract.ts";
import type { ThreadSummary } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { errorText } from "./bb-ports.ts";
import { LoadingState } from "./empty-states.tsx";
import { formatListDate, participantsLabel, subjectOrPlaceholder } from "./thread-list.tsx";
import { tx } from "./i18n/index.ts";

export interface ProjectsViewProps {
  /** The project shown; null: the list of projects with bindings. */
  projectId: string | null;
  loadProjects: () => Promise<{ projects: ProjectListItem[]; bindings: BindingView[] }>;
  loadMail: (projectId: string, cursor: string | null) => Promise<{ threads: ThreadSummary[]; next: string | null }>;
  onSelectProject: (projectId: string | null) => void;
  onOpen: (accountId: string, threadId: string) => void;
  onOpenInBb: (projectId: string) => void;
  refreshKey?: number;
}

export function ProjectsView(props: ProjectsViewProps) {
  const { loadProjects, refreshKey = 0 } = props;
  const [lists, setLists] = useState<{ projects: ProjectListItem[]; bindings: BindingView[] } | null>(null);
  useEffect(() => {
    let live = true;
    loadProjects().then(
      (found) => {
        if (live) setLists(found);
      },
      () => {
        if (live) setLists({ projects: [], bindings: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [loadProjects, refreshKey]);
  const name = (id: string) => lists?.projects.find((p) => p.id === id)?.name ?? lists?.bindings.find((b) => b.projectId === id)?.projectName ?? id;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {props.projectId !== null ? (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => props.onSelectProject(null)}>
            <Icon name="ArrowLeft" aria-hidden />
            {tx("Projects")}
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 text-lg font-semibold text-foreground">
          {props.projectId === null ? tx("Projects") : name(props.projectId)}
        </h1>
        {props.projectId !== null ? (
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => props.onOpenInBb(props.projectId!)}>
            {tx("Open in BB")}
          </Button>
        ) : null}
      </div>
      {props.projectId === null ? (
        <ProjectList lists={lists} onSelect={props.onSelectProject} />
      ) : (
        <ProjectMail key={props.projectId} {...props} projectId={props.projectId} />
      )}
    </div>
  );
}

function ProjectList({ lists, onSelect }: { lists: { projects: ProjectListItem[]; bindings: BindingView[] } | null; onSelect: (id: string) => void }) {
  if (lists === null) return <LoadingState label={tx("Loading projects\u2026")} />;
  const bound = new Map<string, { name: string; rules: number; removed: boolean }>();
  for (const binding of lists.bindings) {
    const entry = bound.get(binding.projectId) ?? { name: binding.projectName ?? binding.projectId, rules: 0, removed: binding.removed };
    entry.rules += 1;
    bound.set(binding.projectId, entry);
  }
  const rows = [
    ...lists.projects.map((p) => ({ id: p.id, name: p.name, rules: bound.get(p.id)?.rules ?? 0, removed: false })),
    ...[...bound.entries()].filter(([id]) => !lists.projects.some((p) => p.id === id)).map(([id, e]) => ({ id, ...e })),
  ];
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{tx("No BB projects.")}</p>;
  return (
    <ul aria-label={tx("Projects")} className="flex flex-col divide-y divide-border rounded-md border border-border">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => onSelect(row.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">{row.name}</span>
            {row.removed ? <span className="text-xs text-muted-foreground">{tx("project removed")}</span> : null}
            {row.rules > 0 ? <span className="text-xs text-muted-foreground">{`${row.rules} ${row.rules === 1 ? "rule" : "rules"}`}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProjectMail({ projectId, loadMail, onOpen, refreshKey = 0 }: ProjectsViewProps & { projectId: string }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const page = await loadMail(projectId, null);
      setThreads(page.threads);
      setNext(page.next);
      setError(null);
    } catch (problem) {
      setError(errorText(problem, "The project's mail could not be loaded"));
    }
  }, [loadMail, projectId]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  const more = async () => {
    if (next === null) return;
    try {
      const page = await loadMail(projectId, next);
      setThreads((prev) => [...(prev ?? []), ...page.threads]);
      setNext(page.next);
    } catch (problem) {
      setError(errorText(problem, "The project's mail could not be loaded"));
    }
  };
  return (
    <>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {threads === null ? (
        error === null ? <LoadingState label={tx("Loading mail\u2026")} /> : null
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tx("No conversation is bound to this project. Use the Project chip in a conversation, or Always for a sender.")}
        </p>
      ) : (
        <ul aria-label={tx("Conversations")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {threads.map((thread) => (
            <li key={`${thread.accountId}:${thread.id}`}>
              <button
                type="button"
                onClick={() => onOpen(thread.accountId, thread.id)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex items-baseline gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-sm text-foreground", thread.unreadCount > 0 && "font-semibold")}>
                    {participantsLabel(thread.participants, null)}
                  </span>
                  {thread.lastDate !== null ? (
                    <time dateTime={thread.lastDate} className="shrink-0 text-xs text-muted-foreground">
                      {formatListDate(thread.lastDate)}
                    </time>
                  ) : null}
                </span>
                <span className="truncate text-xs text-muted-foreground">{subjectOrPlaceholder(thread.subject)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {next !== null ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => void more()}>
            {tx("Load more")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
