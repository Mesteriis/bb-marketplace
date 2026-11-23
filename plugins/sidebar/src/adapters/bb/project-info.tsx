import {useEffect, useState} from 'react';
import {experimental_useSidebarThreads, useRpc, type PluginNavPanelProps} from '@get-bb/plugin-sdk/app';
import type {contract} from '../../../server';
import {isCatalogParent} from '../../core/project-catalog';
import '../../ui/project-info.css';

export const projectInfoPath = 'project-info';

export function projectInfoHref(projectId: string) {
    return `/plugins/makosh-sidebar/${projectInfoPath}/${encodeURIComponent(projectId)}`;
}

function ProjectLocation({projectId}: {projectId: string}) {
    const rpc = useRpc<typeof contract>();
    const [path, setPath] = useState<string | null | undefined>();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        rpc.call('paths', null).then(projects => {
            if (live) setPath(projects.find(project => project.id === projectId)?.path ?? null);
        }).catch(() => {
            if (live) setFailed(true);
        });
        return () => { live = false; };
    }, [rpc, projectId]);

    if (failed) return <span role="alert">Не удалось загрузить путь</span>;
    if (path === undefined) return <span role="status">Загрузка…</span>;
    return path ? <code>{path}</code> : 'Локальная папка не задана';
}

export function ProjectInfoPanel({subPath}: PluginNavPanelProps) {
    const {projects, threads, status} = experimental_useSidebarThreads();
    if (status === 'loading') return <p className="sidebar-project-info" role="status">Загрузка проекта…</p>;
    if (status === 'error') return <p className="sidebar-project-info" role="alert">Не удалось загрузить проект.</p>;

    const project = projects.find(item => !item.isPersonal && encodeURIComponent(item.id) === subPath);
    if (!project) return <p className="sidebar-project-info" role="status">
        {subPath ? 'Проект не найден.' : 'Выберите проект в сайдбаре.'}
    </p>;
    const threadCount = threads.filter(thread => thread.projectId === project.id && isCatalogParent(thread)).length;

    return <section className="sidebar-project-info" aria-label="Свойства проекта">
        <h1>{project.name}</h1>
        <dl>
            <dt>Локальная папка</dt>
            <dd><ProjectLocation key={project.id} projectId={project.id}/></dd>
            <dt>Родительские треды вне архива</dt>
            <dd>{threadCount}</dd>
        </dl>
    </section>;
}
