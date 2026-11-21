import {z} from 'zod';

// Compact presentation contract for this plugin's own planning engine.
const step = z.object({title:z.string().max(120),status:z.enum(['pending','active','done','error','skipped'])});
export const planSchema = z.object({
 id:z.string(),title:z.string().max(80),state:z.enum(['running','needs_input','error','done']),
 note:z.string().max(500).optional(),stages:z.array(z.object({name:z.string().max(120),steps:z.array(step).max(30)})).max(12),
 updatedAt:z.number().finite(),hidden:z.enum(['manual','auto']).optional(),
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
