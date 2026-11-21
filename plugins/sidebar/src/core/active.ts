import {nestThreads,type ThreadNode} from './tree';
import {isRunning} from './presentation';
/** Host unread state clears when the owner reads the thread. */
export function activeThreads<T extends ThreadNode['thread'] & {isUnread:boolean;isHidden:boolean}>(threads:readonly T[],filter:'all'|'running'|'unread'='all'):ThreadNode[] {
 const eligible=threads.filter(t=>!t.isArchived&&!t.isHidden);
 const qualifies=new Set(eligible.filter(t=>filter==='running'?isRunning(t):filter==='unread'?t.isUnread:isRunning(t)||t.isUnread||t.hasPendingInteraction||t.planAttention).map(t=>t.id));
 const prune=(nodes:ThreadNode[],insideActive=false):ThreadNode[]=>nodes.flatMap(node=>{
  const selected=insideActive||qualifies.has(node.thread.id);
  const children=prune(node.children,filter==='all'&&selected);
  return selected||children.length?[{...node,children}]:[];
 });
 return prune(nestThreads(eligible));
}
