import {useEffect, useState} from 'react';
import {useRpc, type PluginNavPanelProps} from '@get-bb/plugin-sdk/app';
import type {contract} from '../../../server';
import type {ProjectOverviewData} from '../../core/project-overview';
import type {ProjectActivity} from '../../core/project-activity';
import {ProjectActivityChart} from '../../ui/project-activity';
import {ProjectOverview} from '../../ui/project-overview';

export const projectInfoPath = 'project-info';

export function projectInfoHref(projectId: string) {
    return `/plugins/makosh-sidebar/${projectInfoPath}/${encodeURIComponent(projectId)}`;
}

function ProjectOverviewRoute({projectId}: {projectId: string}) {
    const rpc = useRpc<typeof contract>();
    const [data, setData] = useState<ProjectOverviewData>();
    const [failed, setFailed] = useState(false);
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        let live = true;
        rpc.call('project_overview', {projectId}).then(result => {
            if (live) setData(result);
        }).catch(() => {
            if (live) setFailed(true);
        });
        return () => { live = false; };
    }, [rpc, projectId, revision]);

    if (data) return <ProjectOverview data={data} activity={<ProjectActivityRoute projectId={projectId}/>}/>;
    if (failed) return <p className="sidebar-project-info" role="alert">Не удалось загрузить обзор проекта.{' '}
        <button type="button" onClick={() => { setFailed(false); setRevision(value => value + 1); }}>Повторить</button>
    </p>;
    return <p className="sidebar-project-info" role="status">Загрузка проекта…</p>;
}

function ProjectActivityRoute({projectId}: {projectId: string}) {
    const rpc = useRpc<typeof contract>();
    const [data, setData] = useState<ProjectActivity>();
    const [revision, setRevision] = useState(0);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        rpc.call('project_activity', {projectId}).then(result => {
            if (live) setData(result);
        }).catch(() => {
            if (live) setFailed(true);
        });
        return () => { live = false; };
    }, [rpc, revision, projectId]);

    if (data) return <ProjectActivityChart data={data}/>;
    if (failed) return <p className="overview-empty" role="alert">Не удалось загрузить аналитику.{' '}
        <button type="button" onClick={() => { setFailed(false); setRevision(current => current + 1); }}>Повторить</button>
    </p>;
    return <p className="overview-empty" role="status">Загрузка аналитики…</p>;
}

export function ProjectInfoPanel({subPath}: PluginNavPanelProps) {
    if (!subPath) return <p className="sidebar-project-info" role="status">Выберите проект в сайдбаре.</p>;
    let projectId: string;
    try {
        projectId = decodeURIComponent(subPath);
    } catch {
        return <p className="sidebar-project-info" role="alert">Некорректный адрес проекта.</p>;
    }
    return <ProjectOverviewRoute key={projectId} projectId={projectId}/>;
}
