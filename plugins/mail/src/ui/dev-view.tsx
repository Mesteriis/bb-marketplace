// Dev (slice 3g, #37): GitHub, GitLab, CI and monitoring mail of the last
// days grouped by repository (or monitoring service), judged locally at
// sync. Each row counts what came in, names the latest CI failure and the
// bound project; Mark read and Archive act on the group's messages through
// the ordinary message actions, with Undo.
import { useCallback, useEffect, useState } from "react";
import type { DevGroup } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText } from "./bb-ports.ts";
import { LoadingState } from "./empty-states.tsx";
import { formatListDate } from "./thread-list.tsx";

export interface DevViewProps {
  load: (cursor: string | null) => Promise<{ groups: DevGroup[]; next: string | null }>;
  /** Mark read or Archive a group's messages (the page toasts Undo). */
  onAction: (group: DevGroup, action: "mark_read" | "archive") => Promise<void>;
  onOpenProject: (projectId: string) => void;
  /** Changes when the page should load again (mail changed). */
  refreshKey?: number;
}

const KIND_WORDS: Record<keyof DevGroup["counts"], [string, string]> = {
  ci: ["CI run", "CI runs"],
  pr: ["PR", "PRs"],
  mr: ["MR", "MRs"],
  issue: ["issue", "issues"],
  review: ["review", "reviews"],
  release: ["release", "releases"],
  security: ["security alert", "security alerts"],
  alert: ["alert", "alerts"],
  other: ["other", "other"],
};

/** "2 CI failures - 5 PRs - 1 issue". */
export function groupLine(group: DevGroup): string {
  const parts: string[] = [];
  if (group.ciFailed > 0) parts.push(`${group.ciFailed} CI ${group.ciFailed === 1 ? "failure" : "failures"}`);
  for (const [kind, [one, many]] of Object.entries(KIND_WORDS) as [keyof DevGroup["counts"], [string, string]][]) {
    const count = group.counts[kind];
    if (count > 0 && !(kind === "ci" && group.ciFailed === count)) parts.push(`${count} ${count === 1 ? one : many}`);
  }
  return parts.join(" \u00b7 ");
}

export function groupName(group: DevGroup): string {
  return group.repo ?? (group.source === "monitoring" ? "Monitoring" : group.source === "ci" ? "CI" : group.source);
}

export function DevView({ load, onAction, onOpenProject, refreshKey = 0 }: DevViewProps) {
  const [groups, setGroups] = useState<DevGroup[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const page = await load(null);
      setGroups(page.groups);
      setNext(page.next);
      setError(null);
    } catch (problem) {
      setError(errorText(problem, "Dev could not be loaded"));
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  const more = async () => {
    if (next === null) return;
    try {
      const page = await load(next);
      setGroups((prev) => [...(prev ?? []), ...page.groups]);
      setNext(page.next);
    } catch (problem) {
      setError(errorText(problem, "Dev could not be loaded"));
    }
  };
  const act = async (group: DevGroup, action: "mark_read" | "archive") => {
    const key = `${group.source}:${group.repo ?? ""}`;
    setBusy(key);
    try {
      await onAction(group, action);
      await reload();
    } catch (problem) {
      setError(errorText(problem, "The action did not run"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold text-foreground">Dev</h1>
        <p className="text-xs text-muted-foreground">
          GitHub, GitLab, CI and monitoring mail of the last 7 days, recognised on this computer.
        </p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {groups === null ? (
        error === null ? <LoadingState label={"Loading Dev\u2026"} /> : null
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No dev notifications in the last 7 days.</p>
      ) : (
        <ul aria-label="Repositories" className="flex flex-col divide-y divide-border rounded-md border border-border">
          {groups.map((group) => {
            const key = `${group.source}:${group.repo ?? ""}`;
            return (
              <li key={key} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon
                    name={group.source === "monitoring" ? "Activity" : "GitBranch"}
                    fallback="Folder"
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{groupName(group)}</span>
                  {group.unread > 0 ? <span className="text-xs text-muted-foreground">{`${group.unread} unread`}</span> : null}
                  {group.latestDate !== null ? (
                    <time dateTime={group.latestDate} className="text-xs text-muted-foreground">
                      {formatListDate(group.latestDate)}
                    </time>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{groupLine(group)}</p>
                {group.latestFailure !== null ? (
                  <p className="truncate text-xs text-foreground">{`Latest failure: ${group.latestFailure.subject}`}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {group.projectId !== null ? (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onOpenProject(group.projectId!)}>
                      {`Project ${group.projectName ?? group.projectId}`}
                    </Button>
                  ) : null}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={busy !== null || group.unread === 0}
                    onClick={() => void act(group, "mark_read")}
                  >
                    Mark read
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy !== null} onClick={() => void act(group, "archive")}>
                    Archive
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => void more()}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
