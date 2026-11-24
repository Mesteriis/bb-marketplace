import {nestThreads,type ThreadNode} from './tree';
import {isRunning} from './presentation';
import {requiresAttention} from './work-status';
export const TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep the visible ancestry of recent threads, without bringing along older siblings. */
export function todayScope<T extends {id:string;parentThreadId:string|null;createdAt:number;updatedAt:number;isArchived:boolean;isHidden:boolean}>(threads:readonly T[],now:number) {
 const eligible=threads.filter(thread=>!thread.isArchived&&!thread.isHidden);
 const recent:T[]=[];
 let nextExpiry=Infinity;
 for(const thread of eligible) {
  const latest=Math.max(
   thread.createdAt<=now?thread.createdAt:-Infinity,
   thread.updatedAt<=now?thread.updatedAt:-Infinity,
  );
  if(latest<now-TODAY_WINDOW_MS)continue;
  recent.push(thread);
  nextExpiry=Math.min(nextExpiry, latest+TODAY_WINDOW_MS+1);
 }
 const byId=new Map(eligible.map(thread=>[thread.id,thread]));
 const included=new Set<string>();
 for(const thread of recent) {
  let ancestor:T|undefined=thread;
  while(ancestor&&!included.has(ancestor.id)) {
   included.add(ancestor.id);
   ancestor=ancestor.parentThreadId===null?undefined:byId.get(ancestor.parentThreadId);
  }
 }
 return {recent,nextExpiry,withAncestors:eligible.filter(thread=>included.has(thread.id))};
}

export function todayThreads<T extends ThreadNode['thread'] & {isUnread:boolean;isHidden:boolean}>(threads:readonly T[],filter:'all'|'running'|'unread'|'attention'='all',recentIds?:ReadonlySet<string>):ThreadNode[] {
 const eligible=threads.filter(t=>!t.isArchived&&!t.isHidden);
 const tree=nestThreads(eligible);
 if(filter==='all')return tree;
 const qualifies=(thread:ThreadNode['thread'])=>(!recentIds||recentIds.has(thread.id))&&
  (filter==='running'?isRunning(thread):filter==='unread'?thread.isUnread:requiresAttention(thread));
 const prune=(nodes:ThreadNode[]):ThreadNode[]=>nodes.flatMap(node=>{
  const children=prune(node.children);
  return qualifies(node.thread)||children.length?[{...node,children}]:[];
 });
 return prune(tree);
}
