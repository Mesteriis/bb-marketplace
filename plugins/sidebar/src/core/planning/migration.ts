import {z} from 'zod';

const time=z.number().finite();
const step=z.object({title:z.string(),status:z.enum(['pending','active','done','error','skipped']),startedAt:time.optional(),endedAt:time.optional()}).strict();
const bar=z.object({id:z.string(),title:z.string(),kind:z.enum(['plan','todo']),state:z.enum(['running','needs_input','error','done']),note:z.string().optional(),
 stages:z.array(z.object({name:z.string(),steps:z.array(step).max(30)}).strict()).max(12),createdAt:time,updatedAt:time,endedAt:time.optional(),hidden:z.enum(['manual','auto']).optional(),autoCloseHandledAt:time.optional()}).strict();
const reminder=z.object({since:time,lastSeq:time,work:time,sinceUpdate:time,hasPlan:z.boolean(),sent:z.boolean(),turnId:z.string().nullable(),finished:z.boolean(),rootConfirmed:z.boolean(),delivery:z.enum(['not-attempted','unknown','sent','send-error','skipped']),attemptedAt:time.nullable()}).strict();
const agent=z.object({id:z.string(),name:z.string(),kind:z.string().nullable(),model:z.string().nullable(),state:z.enum(['running','done','error','unknown']),tool:z.string().nullable(),startedAt:time,endedAt:time.nullable(),aliases:z.array(z.string()).optional(),observedAt:time.optional(),threadId:z.string().optional()}).strict();
export const migrationKey=z.string().regex(/^(bars|agent-errors|reminder-v06):[^\s:]+$/).max(250);
export const migrationEntry=z.object({key:migrationKey,value:z.json()}).strict().superRefine((entry,context)=>{
 const schema=entry.key.startsWith('bars:')?z.array(bar).max(100):entry.key.startsWith('agent-errors:')?z.array(agent).max(100):reminder;
 if(!schema.safeParse(entry.value).success)context.addIssue({code:'custom',message:'Invalid progress record'});
 if(new TextEncoder().encode(JSON.stringify(entry.value)).length>240*1024)context.addIssue({code:'custom',message:'Progress record exceeds storage limit'});
});
export type MigrationEntry=z.infer<typeof migrationEntry>;
/** Compare values, independent of object field order. Arrays remain ordered. */
export function sameRecord(a:unknown,b:unknown):boolean {
 if(a===b)return true;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,i)=>sameRecord(value,b[i]));
 if(a&&b&&typeof a==='object'&&typeof b==='object') {
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
  return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(key=>Object.hasOwn(y,key)&&sameRecord(x[key],y[key]));
 }
 return false;
}
