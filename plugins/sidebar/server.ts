import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const contract = defineRpcContract({
    paths: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })) },
});
export default function plugin(bb: BbPluginApi) {
    bb.settings.define({threadLimit:{type:'number',label:'Тредов в папке',description:'Сколько тредов показывать до кнопки «Показать больше». От 1 до 1000.',default:5,experimental_schema:z.number().int().min(1).max(1000)},rootPath:{type:'string',label:'Корневая папка проектов',description:'Абсолютный путь. Сама папка не отображается. Проекты вне неё скрыты, но работающие треды остаются видимыми. Пустое значение показывает все проекты.',default:''}});
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
