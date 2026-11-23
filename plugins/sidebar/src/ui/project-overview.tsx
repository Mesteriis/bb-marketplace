import {useId, useState, type KeyboardEvent, type ReactNode} from 'react';
import {overviewTotals, type ProjectOverviewData} from '../core/project-overview';
import {Glyph} from './glyph';
import {ProjectOverviewBreakdown, ProjectOverviewDistribution} from './project-overview-charts';
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

function ProjectSources({sources}: {sources: ProjectOverviewData['project']['sources']}) {
    const primary = sources.find(source => source.isDefault);
    const ordered = primary ? [primary, ...sources.filter(source => source !== primary)] : sources;
    if (!ordered.length) return <p className="overview-empty">У проекта пока нет источников.</p>;

    return <>
        {!primary && <p className="overview-empty">Источник по умолчанию не задан.</p>}
        {ordered.map(source => <section className="overview-card" key={source.id}>
            <header className="overview-section-header">
                <h2><Glyph kind="folder"/>{source.isDefault ? 'Источник по умолчанию' : 'Дополнительный источник'}</h2>
            </header>
            <ProjectSource source={source}/>
        </section>)}
    </>;
}

const projectTabs = [
    {id: 'overview', label: 'Обзор'},
    {id: 'analytics', label: 'Аналитика'},
    {id: 'sources', label: 'Источники'},
] as const;
type ProjectTab = typeof projectTabs[number]['id'];

export function ProjectOverview({data, activity}: {data: ProjectOverviewData; activity: ReactNode}) {
    const [tab, setTab] = useState<ProjectTab>('overview');
    const [visitedAnalytics, setVisitedAnalytics] = useState(false);
    const id = useId();
    const tabId = (key: ProjectTab) => `${id}-tab-${key}`;
    const panelId = (key: ProjectTab) => `${id}-panel-${key}`;

    function select(key: ProjectTab) {
        setTab(key);
        if (key === 'analytics') setVisitedAnalytics(true);
    }

    function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const length = projectTabs.length;
        let next: number;
        switch (event.key) {
            case 'Home': next = 0; break;
            case 'End': next = length - 1; break;
            case 'ArrowLeft': next = (index - 1 + length) % length; break;
            case 'ArrowRight': next = (index + 1) % length; break;
            default: return;
        }
        event.preventDefault();
        const key = projectTabs[next].id;
        select(key);
        event.currentTarget.ownerDocument.getElementById(tabId(key))?.focus();
    }

    const {project, groups} = data;
    const stats = overviewTotals(groups);
    const json = JSON.stringify({...data, metrics: stats}, null, 2);
    const metrics = [
        {label: 'Всего тредов', value: stats.total, icon: 'message'},
        {label: 'Видимые вне архива', value: stats.unarchivedVisible, icon: 'file'},
        {label: 'Видимые родители в Sidebar', value: stats.sidebarParents, icon: 'layers'},
        {label: 'Источники', value: project.sources.length, icon: 'folder'},
    ] as const;

    return <section className="sidebar-project-info overview-page" aria-label="Свойства проекта">
        <header className="overview-top">
            <div className="overview-title">
                <span className="overview-icon"><Glyph kind="project"/></span>
                <h1>{project.name}</h1>
            </div>
            <details className="overview-json">
                <summary>Фрагмент JSON</summary>
                <div className="overview-json-content"><Copy value={json}/><pre>{json}</pre></div>
            </details>
        </header>
        <div className="overview-tabs" role="tablist" aria-label="Разделы проекта">
            {projectTabs.map(({id: key, label}, index) => <button key={key} id={tabId(key)} type="button" role="tab"
                aria-selected={tab === key} aria-controls={panelId(key)} tabIndex={tab === key ? 0 : -1}
                onClick={() => select(key)} onKeyDown={event => moveTab(event, index)}>{label}</button>)}
        </div>
        <div className="overview-tab-panel" id={panelId('overview')} role="tabpanel" aria-labelledby={tabId('overview')}
            hidden={tab !== 'overview'} tabIndex={0}>
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
                        ['Снимок данных', <time dateTime={new Date(data.capturedAt).toISOString()}>{utc(data.capturedAt)}</time>],
                    ]}/>
                </section>
                <ProjectOverviewDistribution stats={stats}/>
            </div>
            <ProjectOverviewBreakdown groups={groups}/>
        </div>
        <div className="overview-tab-panel" id={panelId('analytics')} role="tabpanel" aria-labelledby={tabId('analytics')}
            hidden={tab !== 'analytics'} tabIndex={0}>
            {visitedAnalytics && <section className="overview-card overview-activity">{activity}</section>}
        </div>
        <div className="overview-tab-panel" id={panelId('sources')} role="tabpanel" aria-labelledby={tabId('sources')}
            hidden={tab !== 'sources'} tabIndex={0}>
            <ProjectSources sources={project.sources}/>
        </div>
    </section>;
}
