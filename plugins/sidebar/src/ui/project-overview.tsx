import {useState, type ReactNode} from 'react';
import {overviewTotals, type ProjectOverviewData} from '../core/project-overview';
import {Glyph} from './glyph';
import {ProjectOverviewCharts} from './project-overview-charts';
import './project-info.css';

function utc(timestamp: number) {
    return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function Copy({value}: {value: string}) {
    const [status, setStatus] = useState('');
    return <span className="overview-copy">
        <button type="button" aria-label="Скопировать значение" title="Скопировать" onClick={async () => {
            try {
                await navigator.clipboard.writeText(value);
                setStatus('Скопировано');
            } catch {
                setStatus('Не удалось скопировать');
            }
        }}><Glyph kind="copy"/></button>
        {status && <span role="status">{status}</span>}
    </span>;
}

function PropertyGrid({fields}: {fields: [string, ReactNode][]}) {
    return <dl className="overview-properties">{fields.map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>,
    )}</dl>;
}

function CopyValue({value}: {value: string}) {
    return <span className="overview-copy-value"><code>{value}</code><Copy value={value}/></span>;
}

function ProjectSource({source}: {source: ProjectOverviewData['project']['sources'][number]}) {
    return <PropertyGrid fields={[
        ['ID', <CopyValue value={source.id}/>],
        ['Тип', <span className="overview-tag">{source.type}</span>],
        ['Путь', <CopyValue value={source.path}/>],
        ['По умолчанию', source.isDefault ? 'Да' : 'Нет'],
        ['Создан', utc(source.createdAt)], ['Обновлён', utc(source.updatedAt)],
    ]}/>;
}

function ThreadSample({threads, onOpenThread}: {threads: ProjectOverviewData['threads']; onOpenThread: (id: string) => void}) {
    return <section className="overview-card">
        <header className="overview-section-header"><h2><Glyph kind="message"/>Треды (выборка)</h2></header>
        {!threads.length ? <p className="overview-empty">Нет видимых тредов вне архива.</p> : <div className="overview-table-scroll overview-thread-table">
            <table aria-label="Последние видимые треды вне архива">
                <thead><tr>{['ID', 'Заголовок', 'Статус', 'Видимость', 'Провайдер', 'Создан', 'Обновлён', 'Ждёт ответа']
                    .map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
                <tbody>{threads.map(thread => <tr key={thread.id}>
                    <td><CopyValue value={thread.id}/></td>
                    <td><button className="overview-thread-link" type="button" onClick={() => onOpenThread(thread.id)}>
                        {thread.title ?? 'Без названия'}</button></td>
                    <td><span className="overview-tag" data-status={thread.status}>{thread.status}</span></td>
                    <td><span className="overview-tag">{thread.visibility}</span></td>
                    <td><span className="overview-tag">{thread.providerId}</span></td>
                    <td><time dateTime={new Date(thread.createdAt).toISOString()}>{utc(thread.createdAt)}</time></td>
                    <td><time dateTime={new Date(thread.updatedAt).toISOString()}>{utc(thread.updatedAt)}</time></td>
                    <td>{thread.hasPendingInteraction ? 'Да' : 'Нет'}</td>
                </tr>)}</tbody>
            </table>
        </div>}
    </section>;
}

export function ProjectOverview({data, onOpenThread}: {data: ProjectOverviewData; onOpenThread: (id: string) => void}) {
    const {project, groups} = data;
    const stats = overviewTotals(groups);
    const source = project.sources.find(item => item.isDefault);
    const others = project.sources.filter(item => item !== source);
    const json = JSON.stringify({...data, metrics: stats}, null, 2);
    const metrics = [
        {label: 'Всего тредов', value: stats.total, icon: 'message'},
        {label: 'Видимые вне архива', value: stats.unarchivedVisible, icon: 'file'},
        {label: 'Видимые родители в Sidebar', value: stats.sidebarParents, icon: 'layers'},
        {label: 'Источники', value: project.sources.length, icon: 'folder'},
    ] as const;

    return <section className="sidebar-project-info" aria-label="Обзор проекта">
        <div className="overview-top">
            <div className="overview-breadcrumb" aria-label="Путь страницы">Проекты <span>/</span> {project.name} <span>/</span> Обзор</div>
            <details className="overview-json">
                <summary>Фрагмент JSON</summary>
                <div className="overview-json-content"><Copy value={json}/><pre>{json}</pre></div>
            </details>
        </div>
        <header className="overview-title">
            <span className="overview-icon"><Glyph kind="project"/></span>
            <h1>{project.name}</h1>
            <span className="overview-tag overview-kind">{project.kind}</span>
            <span className="overview-tag">ID: {project.id}</span>
            <time dateTime={new Date(data.capturedAt).toISOString()} className="overview-snapshot">
                Снимок данных: {utc(data.capturedAt)}
            </time>
        </header>
        <dl className="overview-metrics">{metrics.map(({label, value, icon}) =>
            <div className="overview-card overview-metric" key={label}>
                <span className="overview-icon"><Glyph kind={icon}/></span>
                <div><dt>{label}</dt><dd>{value}</dd></div>
            </div>,
        )}</dl>
        <div className="overview-summary-grid">
            <section className="overview-card">
                <header className="overview-section-header"><h2><Glyph kind="info"/>Сводка проекта</h2></header>
                <PropertyGrid fields={[
                    ['ID', <CopyValue value={project.id}/>],
                    ['Имя', project.name],
                    ['Тип', <span className="overview-tag overview-kind">{project.kind}</span>],
                    ['Git remote URL', project.gitRemoteUrl && /^https?:\/\//.test(project.gitRemoteUrl)
                        ? <a href={project.gitRemoteUrl} target="_blank" rel="noopener noreferrer">{project.gitRemoteUrl}</a>
                        : project.gitRemoteUrl ?? 'Не задан'],
                    ['Создан', utc(project.createdAt)], ['Обновлён', utc(project.updatedAt)],
                ]}/>
            </section>
            <section className="overview-card">
                <header className="overview-section-header"><h2><Glyph kind="folder"/>Источник по умолчанию</h2></header>
                {source ? <ProjectSource source={source}/> : <p className="overview-empty">Источник по умолчанию не задан.</p>}
                {others.length > 0 && <details className="overview-other-sources">
                    <summary>Другие источники ({others.length})</summary>
                    {others.map(item => <ProjectSource key={item.id} source={item}/>)}
                </details>}
            </section>
        </div>
        <ProjectOverviewCharts groups={groups}/>
        <ThreadSample threads={data.threads} onOpenThread={onOpenThread}/>
    </section>;
}
