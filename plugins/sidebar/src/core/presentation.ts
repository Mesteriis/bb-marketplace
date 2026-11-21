import { buildProjectTree, type ProjectLocation, type ThreadNode } from './tree';
import { visibleItems, type Hidden } from './visibility';
export function isRunning(thread: {status?:string;descendantRunning?:boolean;activity?:{workflows?:number;backgroundAgents?:number;backgroundCommands?:number;planMode?:number}}) {
  return !!thread.descendantRunning || ['starting','active','stopping'].includes(thread.status ?? '') ||
    Object.values(thread.activity??{}).some(count=>typeof count==='number'&&count>0);
}
/** Derive branch activity without changing the host's execution status. */
export function withBranchActivity<T extends {id:string;parentThreadId:string|null;isArchived:boolean;isHidden:boolean;status?:string;activity?:{workflows?:number;backgroundAgents?:number;backgroundCommands?:number;planMode?:number}}>(threads:readonly T[]):(T&{descendantRunning:boolean})[] {
 const byId=new Map(threads.filter(t=>!t.isArchived&&!t.isHidden).map(t=>[t.id,t]));
 const busyParents=new Set<string>();
 for(const thread of byId.values())if(isRunning(thread)) {
  const seen=new Set([thread.id]);
  let parent=thread.parentThreadId;
  while(parent&&byId.has(parent)&&!seen.has(parent)) {
   seen.add(parent);busyParents.add(parent);parent=byId.get(parent)!.parentThreadId;
  }
 }
 return threads.map(thread=>({...thread,descendantRunning:busyParents.has(thread.id)}));
}
export function runningThreads(nodes: readonly ThreadNode[], includeUnread = false): ThreadNode['thread'][] {
  return nodes.flatMap(node => [...((isRunning(node.thread)||(includeUnread&&(node.thread.isUnread||node.thread.hasPendingInteraction||node.thread.planAttention)))?[node.thread]:[]), ...runningThreads(node.children,includeUnread)]);
}
/** Keep navigation complete while promoting children of an already-shown parent. */
export function omitThreadIds(nodes:readonly ThreadNode[],shown:ReadonlySet<string>):ThreadNode[] {
 return nodes.flatMap(node=>{
  const children=omitThreadIds(node.children,shown);
  return shown.has(node.thread.id)?children:[{...node,children}];
 });
}
export function sidebarPresentation<T extends ThreadNode['thread'] & {isHidden:boolean}>(
 projects: readonly (ProjectLocation & {isPersonal:boolean})[], threads: readonly T[], hidden: Hidden, show: boolean, rootPath: string,
) {
 const root=rootPath.trim().replace(/\\/g,'/').replace(/\/+$/,'');
 const personal=new Set(projects.filter(p=>p.isPersonal).map(p=>p.id));
 const scoped=projects.filter(p=>!p.isPersonal && (!root || p.path===root || p.path?.startsWith(root+'/'))).map(p=>({...p,path:root && p.path ? p.path.slice(root.length)||null:p.path}));
 const scopedIds=new Set(scoped.map(p=>p.id));
 const hiddenPaths=projects.filter(p=>hidden.projects.includes(p.id)&&p.path).map(p=>p.path!.replace(/\\/g,'/').replace(/\/+$/,''));
 const inheritedHidden={...hidden,projects:projects.filter(p=>hidden.projects.includes(p.id)||!!p.path&&hiddenPaths.some(path=>p.path===path||p.path!.startsWith(path+'/'))).map(p=>p.id)};
 const visible=visibleItems(scoped,threads.filter(t=>scopedIds.has(t.projectId)&&!personal.has(t.projectId)),inheritedHidden,show);
 const visibleIds=new Set(visible.projects.map(p=>p.id));
 const treeThreads=visible.threads.filter(t=>visibleIds.has(t.projectId));
 const treeIds=new Set(treeThreads.map(t=>t.id));
 const projectsWithHiddenThreads=new Set(threads.filter(t=>hidden.threads.includes(t.id)).map(t=>t.projectId));
 const projectsWithVisibleThreads=new Set(treeThreads.map(t=>t.projectId));
 // Prune branches emptied by user hiding, preserving genuinely empty projects.
 const treeProjects=visible.projects.filter(p=>show || !projectsWithHiddenThreads.has(p.id) || projectsWithVisibleThreads.has(p.id));
 return {
  tree:buildProjectTree({projects:treeProjects,threads:treeThreads,preserveRootLevel:!!root}),
  loose:threads.filter(t=>personal.has(t.projectId)&&!t.isHidden&&!t.isArchived&&(show||!hidden.threads.includes(t.id)||isRunning(t))),
  running:threads.filter(t=>!t.isHidden&&!t.isArchived&&!personal.has(t.projectId)&&!treeIds.has(t.id)&&isRunning(t)),
 };
}
