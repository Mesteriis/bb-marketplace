import {experimental_useSidebarThreads, useBbNavigate, type PluginNavPanelProps, type PluginSidebarThread} from '@get-bb/plugin-sdk/app';

import {isRunning} from '../../core/presentation';

export const projectThreadsPath = 'projects';

export function projectThreadsHref(projectId: string) {
    return `/plugins/makosh-sidebar/${projectThreadsPath}/${encodeURIComponent(projectId)}`;
}

function threadStatus(thread: PluginSidebarThread) {
    if (thread.hasPendingInteraction) return {text: 'Ждёт ответа', tone: 'waiting'};
    if (thread.status === 'error') return {text: 'Ошибка', tone: 'failed'};
    if (thread.status === 'stopping') return {text: 'Останавливается', tone: 'running'};
    if (isRunning(thread)) return {text: 'В работе', tone: 'running'};
    if (thread.isUnread) return {text: 'Новый ответ', tone: 'unread'};
    return {text: 'Нет активности', tone: 'muted'};
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
        {rows.length ? <ul>{rows.map(thread => {
            const state = threadStatus(thread);
            return <li key={thread.id}>
                <a href={thread.href} onClick={event => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    navigate.toThread(thread.id);
                }}>
                    <span className="project-thread-title">{thread.displayTitle}</span>
                    <span className={`project-thread-status ${state.tone}`}>{state.text}</span>
                </a>
            </li>;
        })}</ul> : <p role="status">Нет неархивных тредов.</p>}
    </section>;
}
