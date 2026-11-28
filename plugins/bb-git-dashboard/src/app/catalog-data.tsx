import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import { repositoryKey, type Project } from "../core/project-workspace.ts";
import type { Copy } from "../core/workspace.ts";

type Host = {id: string; name: string};
const signal = "git-workspace-changed";

/** The attached copies, machines, projects and their places, read again when a copy changes; hidden ones left out. */
export function useCatalog() {
  const client = useRpc<typeof rpc>();
  const [hiddenRepositories,setHiddenRepositories] = useState<string[]>([]);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [projects,setProjects] = useState<Project[]>([]);
  const [locations,setLocations] = useState<{projectId:string;hostId:string;path:string;name:string|null}[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const next = await client.call("catalog");
      setHiddenRepositories(next.hiddenRepositories);
      setCopies(next.copies);
      setHosts(next.hosts);
      setProjects(next.projects);
      setLocations(next.locations);
      setError("");
    } catch { setError("Cannot load repository catalog."); }
    finally { setLoaded(true); }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  useRealtime(signal, reload);
  const hidden = new Set(projects.filter(project => project.hidden).map(project => project.id));
  const projectCopies = useMemo(() => copies.filter(copy => !projects.some(p => p.hidden && p.id === copy.projectId)),[copies,projects]);
  const visibleCopies = useMemo(() => projectCopies.filter(copy => !hiddenRepositories.includes(JSON.stringify([copy.projectId ?? "",repositoryKey(copy)]))),[projectCopies,hiddenRepositories]);
  return {client, copies:visibleCopies,projectCopies,hiddenRepositories, hosts,
    projects:projects.filter(project => !project.hidden), hiddenProjects:projects.filter(project => project.hidden),
    locations:locations.filter(location => !hidden.has(location.projectId)), loaded, error, reload};
}
