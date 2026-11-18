import type { Task } from "./model.ts";

type ProjectTask = Pick<Task, "origin" | "originKey">;

export function projectKeyForTask(task: ProjectTask): string {
  if (task.origin === "local") return "Local tasks";
  return task.originKey?.replace(/-\d+$/, "") || "Jira";
}

export function groupTasksByProject<T extends ProjectTask>(tasks: T[]): { project: string; tasks: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const key = projectKeyForTask(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  return [...groups]
    .sort(([a], [b]) => a === "Local tasks" ? 1 : b === "Local tasks" ? -1 : a.localeCompare(b))
    .map(([project, tasks]) => ({ project, tasks }));
}
