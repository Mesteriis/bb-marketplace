import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useState } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import { nestedFolders, projectTree, type Project } from "../core/project-workspace.ts";
import { categoriesOf } from "../core/projects/table.ts";
import type { Copy } from "../core/workspace.ts";
import { useT } from "../ui/i18n/use-t.tsx";
import type { OverviewApi } from "../ui/overview/overview-api.ts";
import { AddCopy } from "../ui/project-workspace.tsx";
import { ProjectsPage } from "../ui/projects/projects-page.tsx";
import type { ProjectsApi } from "../ui/projects/projects-api.ts";
import { failed, okValue } from "./apis.tsx";

/** Each copy's category: the top folder of its project's tree (copy id → name), "" for a project without a folder. */
export function useCopyCategories(projects: Project[], copies: Copy[]): Map<string, string> {
  return useMemo(() => {
    const byProject = categoriesOf(nestedFolders(projectTree(projects, []), ""));
    return new Map(copies.map(copy => [copy.id, byProject.get(copy.projectId ?? "") ?? ""]));
  }, [projects, copies]);
}

type Location = {projectId: string; hostId: string; path: string; name: string | null};

/** `projects` (every attached copy) and `project/<id>` (one project's copies): the Projects table and the form to attach a copy. */
export function ProjectsRoute({subPath, copies, projects, hosts, locations, loaded, overview, open}: {subPath: string; copies: Copy[];
  projects: Project[]; hosts: {id: string; name: string}[]; locations: Location[]; loaded: boolean; overview: OverviewApi; open(path: string): void}) {
  const t = useT();
  const client = useRpc<typeof rpc>();
  const [adding, setAdding] = useState(false);
  const projectId = subPath.startsWith("project/") ? decode(subPath.slice("project/".length)) : null;
  const project = projectId === null ? null : projects.find(item => item.id === projectId) ?? null;
  const shown = useMemo(() => projectId === null ? copies : copies.filter(copy => (copy.projectId ?? "") === projectId), [copies, projectId]);
  const categories = useCopyCategories(projects, copies);
  const categoryOf = useCallback((copy: Copy) => categories.get(copy.id) ?? "", [categories]);
  const api = useMemo<ProjectsApi>(() => ({
    load: refresh => overview.load(refresh),
    bulk: async (hostId, roots, action) => okValue(await client.call("catalogBulk", {hostId, roots, action})).results
      .map(answer => ({root: answer.root, ok: answer.ok, code: answer.code, behind: answer.value?.behind ?? null})),
    openCopy: copyId => open(copyId),
    openPr: target => overview.open({kind: "pr", ...target}),
  }), [client, overview, open]);
  const hostName = useCallback((id: string) => hosts.find(host => host.id === id)?.name ?? id, [hosts]);
  // `project/` (no id) is the copies of no project, as the sidebar names them.
  if (projectId !== null && projectId !== "" && loaded && !project) return <div className="g-page"><p className="g-state-page" role="status">{t("pj.project-missing")}</p></div>;
  const available = locations.filter(location => (projectId === null || location.projectId === projectId)
    && !copies.some(copy => copy.hostId === location.hostId && copy.root === location.path));
  return <ProjectsPage api={api} copies={shown} categoryOf={categoryOf} hostName={hostName} title={projectId === "" ? t("pj.unassigned") : project?.name ?? t("section.projects")} ready={loaded}
    onAdd={() => setAdding(value => !value)} adding={adding && <div className="git-projects-add">
      <AddCopy hosts={hosts} locations={available} projects={projects} onSubmit={async (hostId, root, source, sourceProject) => {
        const target = sourceProject || projectId || undefined;
        const result = source ? await client.call("cloneLocal", {hostId, source, destination: root, projectId: target})
          : await client.call("attach", {hostId, root, projectId: target});
        if (!result.ok) failed(result);
        setAdding(false);
        open(result.value.id);
      }}/>
    </div>}/>;
}

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return ""; }
}
