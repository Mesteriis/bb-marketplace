import {experimental_useSidebarThreads, useBbNavigate, type PluginNavPanelProps} from '@get-bb/plugin-sdk/app';

export const projectThreadsPath = 'projects';

export function projectThreadsHref(projectId: string) {
    return `/plugins/makosh-sidebar/${projectThreadsPath}/${encodeURIComponent(projectId)}`;
}

export function ProjectThreads({subPath}: PluginNavPanelProps) {
    const {projects, threads, status} = experimental_useSidebarThreads();
    const navigate = useBbNavigate();
    if (status === 'loading') return <p role="status">Загрузка тредов…</p>;
    if (status === 'error') return <p role="alert">Не удалось загрузить треды проекта.</p>;

    const project = projects.find(item => encodeURIComponent(item.id) === subPath);
    if (!project) return <p className="project-threads" role="status">
        {subPath ? 'Проект не найден.' : 'Выберите проект в боковой панели.'}
    </p>;
    const rows = threads.filter(thread => thread.projectId === project.id && !thread.isHidden && !thread.isArchived)
        .sort((a, b) => b.latestAttentionAt - a.latestAttentionAt);

    const title = project.isPersonal ? 'Без проекта' : project.name;
    return <section className="project-threads" aria-label={project.isPersonal ? 'Треды без проекта' : `Треды проекта ${title}`}>
        <header>
            <h1>{title}</h1>
            <button type="button" onClick={() => navigate.toCompose({projectId: project.id})}>Новый тред</button>
        </header>
        {rows.length ? <ul>{rows.map(thread => <li key={thread.id}>
            <a href={thread.href} onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate.toThread(thread.id);
            }}>{thread.displayTitle}</a>
        </li>)}</ul> : <p role="status">Нет неархивных тредов.</p>}
    </section>;
}
