import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {progressSchema} from './src/core/progress';
import registerPlanning from './src/adapters/bb/planning/server';
import {sidebarPlans} from './src/core/progress';
import {migrationEntry,migrationKey} from './src/core/planning/migration';
export const contract = defineRpcContract({
    paths: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })) },
    progress: {input:z.object({threadIds:z.array(z.string().min(1).max(200)).max(25)}),output:progressSchema},
    attention:{input:z.null(),output:z.object({entries:z.array(z.object({threadId:z.string(),state:z.enum(['needs_input','error'])})),incomplete:z.boolean()})},
    progress_import:{input:z.object({entries:z.array(migrationEntry).max(25)}),output:z.object({imported:z.number(),unchanged:z.number(),conflicts:z.array(z.string())})},
    progress_export:{input:z.object({keys:z.array(migrationKey).max(25)}),output:z.object({entries:z.array(z.object({key:z.string(),value:z.json()}))})},
});
export default async function plugin(bb: BbPluginApi) {
    const planning=await registerPlanning(bb);
    bb.rpc.register(contract, {
        attention:()=>planning.attention(),
        progress_import:({entries})=>planning.importRecords(entries),
        progress_export:async({keys})=>{
            const entries=[];
            for(const key of keys) {const value=await bb.storage.kv.get<z.infer<ReturnType<typeof z.json>>>(key);if(value!==undefined&&value!==null)entries.push({key,value});}
            return {entries};
        },
        progress: async ({threadIds})=>{
            const entries=[];
            const failedThreadIds=[];
            for(const threadId of new Set(threadIds)) {
                try {entries.push({threadId,plans:sidebarPlans(await planning.readBars(threadId))});}
                catch {failedThreadIds.push(threadId);}
            }
            return {availability:'ready' as const,entries,failedThreadIds};
        },
        async paths() {
            const projects = await bb.sdk.projects.list({ includePersonal: true });
            return projects.map(project => {
                const sources = project.sources.filter(s => s.type === 'local_path');
                return { id: project.id, name: project.name, path: (sources.find(s => s.isDefault) ?? sources[0])?.path ?? null };
            });
        },
    });
}
