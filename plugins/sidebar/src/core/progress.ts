import {z} from 'zod';

// Compact presentation contract for this plugin's own planning engine.
const step = z.object({title:z.string().max(120),status:z.enum(['pending','active','done','error','skipped']),startedAt:z.number().finite().optional(),endedAt:z.number().finite().optional()});
export const planSchema = z.object({
 id:z.string(),title:z.string().max(80),state:z.enum(['running','needs_input','error','done']),
 note:z.string().max(500).optional(),stages:z.array(z.object({name:z.string().max(120),steps:z.array(step).max(30)})).max(12),
 createdAt:z.number().finite().optional(),endedAt:z.number().finite().optional(),updatedAt:z.number().finite(),hidden:z.enum(['manual','auto']).optional(),
});
export type Plan = z.infer<typeof planSchema>;
export const progressSchema = z.object({
 availability:z.enum(['ready','unavailable']),
 entries:z.array(z.object({threadId:z.string(),plans:z.array(planSchema)})),
 failedThreadIds:z.array(z.string()),
});
export type ProgressResult = z.infer<typeof progressSchema>;
export const planLabels = {running:'В работе',needs_input:'Нужен ответ',error:'Ошибка плана',done:'План готов'} as const;
const priority = {error:0,needs_input:1,running:2,done:3};
export function visiblePlans(plans:readonly Plan[]):Plan[] {
 return plans.filter(p=>!p.hidden).sort((a,b)=>priority[a.state]-priority[b.state]||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
}
export function planProgress(plan:Plan) {
 const steps=plan.stages.flatMap(stage=>stage.steps);
 const done=steps.filter(s=>s.status==='done'||s.status==='skipped').length;
 const active=steps.find(s=>s.status==='active')??steps.find(s=>s.status==='error');
 const stage=plan.stages.find(s=>s.steps.includes(active!));
 return {done,total:steps.length,percent:steps.length?Math.round(done/steps.length*100):0,stage:stage?.name??'',step:active?.title??''};
}

/** Auto-hidden completions remain history; explicit user hiding stays respected. */
export function sidebarPlans(plans:readonly Plan[]):Plan[] {
 return plans.filter(p=>p.hidden!=='manual').sort((a,b)=>priority[a.state]-priority[b.state]||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
}
export interface ProgressThread {id:string;parentThreadId:string|null;title:string;plans:readonly Plan[]}
/** Use deepest planned branches, avoiding coordinator/worker double counting. */
export function aggregateProgress(threads:readonly ProgressThread[]):Plan|null {
 if(!threads.length)return null;
 threads=threads.map(t=>({...t,plans:sidebarPlans(t.plans)}));
 const byId=new Map(threads.map(t=>[t.id,t]));
 const covered=new Set<string>();
 for(const thread of threads)if(thread.plans.length) {
  const seen=new Set([thread.id]);let parent=thread.parentThreadId;
  while(parent&&byId.has(parent)&&!seen.has(parent)) {seen.add(parent);covered.add(parent);parent=byId.get(parent)!.parentThreadId;}
 }
 const contributions=threads.filter(t=>!covered.has(t.id));
 const plans=contributions.flatMap(t=>[...t.plans].sort((a,b)=>(a.createdAt??a.updatedAt)-(b.createdAt??b.updatedAt)||a.id.localeCompare(b.id)).map(plan=>({thread:t,plan})));
 const missing=contributions.filter(t=>!t.plans.length).length;
 const stages=plans.flatMap(({thread,plan})=>plan.stages.map(stage=>({name:[thread.title,plan.title,stage.name].filter(Boolean).join(' · '),steps:stage.steps})));
 const steps=stages.flatMap(s=>s.steps);
 const done=steps.filter(s=>s.status==='done'||s.status==='skipped').length;
 const state=plans.some(p=>p.plan.state==='error')?'error':plans.some(p=>p.plan.state==='needs_input')?'needs_input':steps.length&&done===steps.length&&!missing?'done':'running';
 const starts=plans.flatMap(p=>p.plan.createdAt===undefined?[]:[p.plan.createdAt]);
 const ends=plans.flatMap(p=>p.plan.endedAt===undefined?[]:[p.plan.endedAt]);
 return {id:'subthread-aggregate',title:'Общий прогресс субтредов',state,stages,
  note:missing?`Без плана: ${missing}`:undefined,createdAt:starts.length?Math.min(...starts):undefined,
  endedAt:state==='done'&&ends.length===plans.length?Math.max(...ends):undefined,
  updatedAt:Math.max(0,...plans.map(p=>p.plan.updatedAt))};
}
export function elapsed(ms:number):string {
 const sec=Math.max(0,Math.round(ms/1000));
 return sec<60?`${sec}s`:sec<3600?`${Math.floor(sec/60)}m ${sec%60}s`:`${Math.floor(sec/3600)}h ${Math.floor(sec%3600/60)}m`;
}
// Timing labels adapted from Plan Progress 0.6.0 (MIT, Yuri Smirnov).
export function progressMarks(plan:Plan) {
 const total=plan.stages.flatMap(s=>s.steps).length;
 let k=0;
 return plan.stages.flatMap((stage,i)=>stage.steps.flatMap((step,j)=>{
  const at=k++/total;if(!at)return [];
  const isStage=j===0,before=isStage?plan.stages[i-1]:stage;
  const ended=isStage?before?.steps:stage.steps.slice(j-1,j);
  const passed=!!ended?.length&&ended.every(s=>s.status==='done'||s.status==='skipped');
  const label=passed?(isStage?before?.name:ended?.[0]?.title):(isStage?stage.name:step.title);
  const starts=ended?.flatMap(s=>s.startedAt===undefined?[]:[s.startedAt])??[];
  const ends=ended?.flatMap(s=>s.endedAt===undefined?[]:[s.endedAt])??[];
  return [{at,isStage,label:`${label||step.title}${passed&&starts.length&&ends.length?' · '+elapsed(Math.max(...ends)-Math.min(...starts)):''}`}];
 }));
}
