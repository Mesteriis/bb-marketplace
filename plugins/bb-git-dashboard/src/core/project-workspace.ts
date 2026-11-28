import { z } from "zod";
import type { Copy } from "./workspace.ts";

export const source = z.object({id:z.string(),hostId:z.string(),path:z.string(),isDefault:z.boolean()});
export type Source = z.infer<typeof source>;
export const project = z.object({id:z.string(), name:z.string(), sources:source.array().optional(), hidden:z.boolean().optional(), folder:z.object({path:z.string(),hostId:z.string()}).optional()});
export type Project = z.infer<typeof project>;
type Location = {hostId:string;path:string;projectId:string};
export type WorkspaceRepository = {key:string;name:string;copies:Copy[]};

export function projectForCopy(copy:Copy, projects:Project[], locations:Location[]) {
  const known = new Set(projects.map(project => project.id));
  if (copy.projectId && known.has(copy.projectId)) return copy.projectId;
  const matches = new Set(locations.filter(location => location.hostId === copy.hostId &&
    location.path === copy.root && known.has(location.projectId)).map(location => location.projectId));
  return matches.size === 1 ? [...matches][0] : undefined;
}

export function repositoryKey(copy: Copy) {
  return copy.hostId + "/" + (copy.repository ?? copy.id);
}

export function projectTree(projects:Project[], copies:Copy[]) {
  const groups = [...projects, {id:"",name:"Unassigned"}];
  return groups.map(group => {
    const repositories = new Map<string, WorkspaceRepository>();
    for (const copy of copies) {
      if ((copy.projectId ?? "") !== group.id) continue;
      const key = repositoryKey(copy);
      const existing = repositories.get(key);
      if (existing) {
        existing.copies.push(copy);
        if (copy.repositoryName) existing.name = copy.repositoryName;
      } else repositories.set(key, {
        key, name:copy.repositoryName || copy.root.split(/[\\/]/).pop() || copy.root, copies:[copy],
      });
    }
    return {...group,repositories:[...repositories.values()].map(repo => ({
      ...repo, copies:[...repo.copies].sort((left,right) => {
        const primary = (copy:Copy) => copy.root.split(/[\\/]/).pop() === repo.name;
        return Number(primary(right)) - Number(primary(left)) || left.root.localeCompare(right.root);
      }),
    })).sort((left,right) => left.name.localeCompare(right.name))};
  }).filter(group => group.id || group.repositories.length);
}

export function sidebarFolders(rows:ReturnType<typeof projectTree>, query:string) {
  const needle = query.trim().toLocaleLowerCase();
  const folders = new Map<string,{key:string;path:string;hostId:string;label:string;rows:typeof rows}>();
  for (const row of rows) {
    const path = row.folder?.path ?? "";
    const hostId = row.folder?.hostId ?? "";
    const key = JSON.stringify([hostId,path]);
    const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
    if (![row.name,path,label,...(row.sources ?? []).map(source => source.path)].some(value => value.toLocaleLowerCase().includes(needle))) continue;
    const folder = folders.get(key) ?? {key,path,hostId,label,rows:[]};
    folder.rows.push(row);
    folders.set(key,folder);
  }
  const result = [...folders.values()];
  for (const folder of result) folder.rows.sort((a,b) => a.name.localeCompare(b.name));
  return result.sort((a,b) => Number(!a.path)-Number(!b.path) || a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

type ProjectRow = ReturnType<typeof projectTree>[number];
/** A folder of the tree: its name relative to the folder above it (the projects folder at the top), and its full path. */
export type FolderNode = {key:string;label:string;path:string;rows:ProjectRow[];children:FolderNode[];count:number};

export function nestedFolders(rows:ProjectRow[],query:string) {
  const roots:FolderNode[] = [];
  for (const folder of sidebarFolders(rows,query)) {
    const parts = folder.path.split(/[\\/]/).filter(Boolean);
    if (!parts.length) parts.push(folder.label);
    let siblings = roots;
    const prefix = [folder.hostId,folder.path.startsWith("/") ? "/" : ""];
    const separator = folder.path.includes("\\") && !folder.path.includes("/") ? "\\" : "/";
    for (const [index,label] of parts.entries()) {
      prefix.push(label);
      const key = JSON.stringify(prefix);
      let node = siblings.find(item => item.key === key);
      if (!node) {
        const path = folder.path ? (folder.path.startsWith("/") ? "/" : "") + parts.slice(0, index + 1).join(separator) : "";
        node = {key,label,path,rows:[],children:[],count:0};
        siblings.push(node);
      }
      node.count += folder.rows.length;
      if (index === parts.length-1) node.rows.push(...folder.rows);
      siblings = node.children;
    }
  }
  // A chain of folders holding no project folds into its last folder, which keeps its own name.
  function compact(nodes:FolderNode[]):FolderNode[] {
    return nodes.map(start => {
      let node = start;
      while (!node.rows.length && node.children.length === 1) node = node.children[0];
      return {...node,children:compact(node.children)};
    }).sort((a,b) => a.label.localeCompare(b.label));
  }
  // The folder all projects of a machine share is the projects folder: when it holds no project itself, its
  // categories are the top of the tree (Personal, Work), named relative to it.
  let top = compact(roots);
  while (top.length === 1 && !top[0].rows.length && top[0].children.length > 1) top = top[0].children;
  return top;
}
