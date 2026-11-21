import {isRunning} from './presentation';
import type {ThreadNode,TreeNode} from './tree';
type Thread=ThreadNode['thread'];
export const requiresAttention=(thread:Thread)=>!!thread.hasPendingInteraction||!!thread.planAttention||thread.status==='error';
export function attentionThreads<T extends Thread>(threads:readonly T[]):T[] {
 const rank=(t:T)=>t.hasPendingInteraction||t.planAttention==='needs_input'?0:1;
 return threads.filter(requiresAttention).sort((a,b)=>rank(a)-rank(b)||b.latestAttentionAt-a.latestAttentionAt||a.id.localeCompare(b.id));
}
export function waitingReason(children:readonly Thread[]):string|undefined {
 const pending=children.filter(t=>isRunning(t)||requiresAttention(t));
 if(!pending.length)return undefined;
 const n=pending.length,word=n%10===1&&n%100!==11?'субтред':n%10>=2&&n%10<=4&&!(n%100>=12&&n%100<=14)?'субтреда':'субтредов';
 return `Ждёт ${n} ${word}`;
}
/** Keep ancestor folders when a nested project matches; a matching folder keeps its subtree. */
export function searchProjects(nodes:readonly TreeNode[],query:string):TreeNode[] {
 const term=query.trim().toLocaleLowerCase();
 if(!term)return [...nodes];
 return nodes.flatMap(node=>{
  if([node.label,node.project?.name??''].some(value=>value.toLocaleLowerCase().includes(term)))return [node];
  const children=searchProjects(node.children,term);
  return children.length?[{...node,children}]:[];
 });
}
export function ageLabel(ms:number):string {
 const seconds=Math.max(0,Math.floor(ms/1000));
 return seconds<60?`${seconds} с`:seconds<3600?`${Math.floor(seconds/60)} мин`:`${Math.floor(seconds/3600)} ч`;
}
