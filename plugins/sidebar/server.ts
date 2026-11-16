import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const contract = defineRpcContract({
    paths: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })) },
});
export default function plugin(bb: BbPluginApi) {
    bb.settings.define({rootPath:{type:'string',label:'Корневая папка проектов',description:'Абсолютный путь. Сама папка не отображается. Проекты вне неё скрыты, но работающие треды остаются видимыми. Пустое значение показывает все проекты.',default:''}});
    bb.rpc.register(contract, {
        async paths() {
            const projects = await bb.sdk.projects.list({ includePersonal: true });
            return projects.map(project => {
                const sources = project.sources.filter(s => s.type === 'local_path');
                return { id: project.id, name: project.name, path: (sources.find(s => s.isDefault) ?? sources[0])?.path ?? null };
            });
        },
    });
}
