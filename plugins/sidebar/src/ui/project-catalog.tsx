import {useEffect, useRef, useState, type ReactNode} from 'react';
import {filterCatalog, type CatalogRow, type CatalogSort, type CatalogThread} from '../core/project-catalog';
import type {WorktreeIssue} from '../core/project-worktrees';
import {Glyph} from './glyph';
import {CatalogThreads} from './catalog-threads';
import {ProjectActionDialog, projectActionLabels, type ProjectAction, type ProjectActionTarget} from './project-action-dialog';
import './project-catalog.css';

type Props = {
    rows: readonly CatalogRow[];
    activeProjectId: string | null;
    activeThreadId: string | null;
    projectless?: {id: string; threads: readonly CatalogThread[]};
    onOpenThread: (id: string, split: boolean) => void;
    onCompose: (id: string) => void;
    onOpenProjectInfo: (id: string) => void;
    onToggleHidden: (id: string) => void;
    onProjectAction: (action: ProjectAction, id: string, acknowledged?: readonly WorktreeIssue[]) => Promise<WorktreeIssue[]>;
    onPrepareMerge: (projectId: string, environmentId: string) => void;
};

function Overlay({label, icon, open, onOpenChange, children}: {
    label: string;
    icon: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return;
        function dismiss(event: PointerEvent) {
            if (event.target instanceof Node && !root.current?.contains(event.target)) onOpenChange(false);
        }
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [open, onOpenChange]);

    return <div className="catalog-overlay" ref={root} onKeyDown={event => {
        if (!open || event.key !== 'Escape') return;
        event.stopPropagation();
        onOpenChange(false);
        trigger.current?.focus();
    }}>
        <button type="button" ref={trigger} aria-label={label} aria-expanded={open}
            onClick={() => onOpenChange(!open)}>{icon}</button>
        {open && <div className="catalog-popover" role="group" aria-label={label}>{children}</div>}
    </div>;
}

function ProjectStatus({row}: {row: CatalogRow}) {
    const status =
        row.hidden ? {label: 'Скрыт', kind: 'muted', icon: 'eye'} as const :
        row.empty ? {label: 'Пустой', kind: 'muted', icon: 'inbox'} as const :
        row.waiting ? {label: 'Ждёт ответа', kind: 'waiting', icon: 'clock'} as const :
        row.failed ? {label: 'Ошибка', kind: 'failed', icon: 'warning'} as const :
        row.running ? {label: `${row.running} в работе`, kind: 'running', icon: 'activity', count: row.running} as const :
        row.unread ? {label: row.unread === 1 ? '1 новый ответ' : `${row.unread} новых`, kind: 'unread', icon: 'dot', count: row.unread} as const : null;
    return status && <span className={`catalog-status ${status.kind}`} role="img" aria-label={status.label} title={status.label}>
        <Glyph kind={status.icon}/>
        {'count' in status && <span aria-hidden="true">{status.count}</span>}
    </span>;
}

export function ProjectCatalog({rows, activeProjectId, activeThreadId, projectless, onOpenThread, onCompose, onOpenProjectInfo, onToggleHidden, onProjectAction, onPrepareMerge}: Props) {
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState('');
    const [sort, setSort] = useState<CatalogSort>('activity');
    const [showHidden, setShowHidden] = useState(false);
    const [showEmpty, setShowEmpty] = useState(false);
    const [overlay, setOverlay] = useState<{id: string} | 'visibility' | null>(null);
    const [actionTarget, setActionTarget] = useState<ProjectActionTarget | null>(null);
    const search = useRef<HTMLInputElement>(null);
    const scopes = [...new Set(rows.map(row => row.scope).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const selectedScope = scopes.includes(scope) ? scope : '';
    const visible = filterCatalog(rows, {query, scope: selectedScope, sort, showHidden, showEmpty});

    const [expandedId, setExpandedId] = useState<string | null>(null);
    function toggleExpanded(id: string, openOverview: boolean) {
        const opening = expandedId !== id;
        setExpandedId(opening ? id : null);
        if (opening && openOverview) onOpenProjectInfo(id);
    }

    return <div className="project-catalog">
        <div className="catalog-search">
            <label className="project-search">
                <Glyph kind="search"/>
                <input ref={search} aria-label="Найти проект" placeholder="Найти проект" value={query}
                    onChange={event => setQuery(event.target.value)}/>
            </label>
            <Overlay label="Видимость проектов" icon={<Glyph kind="sliders"/>} open={overlay === 'visibility'}
                onOpenChange={open => setOverlay(open ? 'visibility' : null)}>
                <strong>Видимость проектов</strong>
                <label><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)}/>
                    Показывать скрытые</label>
                <label><input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)}/>
                    Показывать пустые</label>
            </Overlay>
        </div>
        <div className="catalog-toolbar">
            <div className="catalog-scopes" role="group" aria-label="Папка проектов">
                <button type="button" aria-pressed={!selectedScope} onClick={() => setScope('')}>Все</button>
                {scopes.map(folder => <button key={folder} type="button" aria-pressed={selectedScope === folder}
                    onClick={() => setScope(folder)}>{folder}</button>)}
            </div>
            <select aria-label="Сортировка проектов" value={sort}
                onChange={event => setSort(event.target.value === 'name' ? 'name' : 'activity')}>
                <option value="activity">По активности</option>
                <option value="name">По имени</option>
            </select>
        </div>
        {projectless && <div className="catalog-projectless">
            <div className={`catalog-row${projectless.id === activeProjectId ? ' selected' : ''}`}>
                <button type="button" className="catalog-disclosure" aria-expanded={expandedId === projectless.id}
                    onClick={() => toggleExpanded(projectless.id, false)}>
                    <span className="catalog-chevron"><Glyph kind="chevron"/></span>
                    Без проекта
                </button>
            </div>
            {expandedId === projectless.id && <CatalogThreads label="Треды без проекта" threads={projectless.threads}
                activeThreadId={activeThreadId} onOpen={onOpenThread}/>}
        </div>}
        <ul className="catalog-list" aria-label="Проекты">
            {visible.map(row => <li key={row.id}>
                <div className={`catalog-row${row.id === activeProjectId ? ' selected' : ''}`}>
                    <button type="button" className="catalog-disclosure" aria-expanded={expandedId === row.id}
                        onClick={() => toggleExpanded(row.id, true)}>
                        <span className="catalog-chevron"><Glyph kind="chevron"/></span>
                        <span className="catalog-name" title={row.name}>{row.name}</span>
                        {row.folder && <span className="catalog-path" title={row.folder}>{row.folder}</span>}
                        <ProjectStatus row={row}/>
                    </button>
                    <Overlay label={`Действия проекта ${row.name}`} icon="⋯"
                        open={typeof overlay === 'object' && overlay?.id === row.id}
                        onOpenChange={open => setOverlay(open ? {id: row.id} : null)}>
                        <a href={row.infoHref} onClick={event => {
                            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            setOverlay(null);
                            onOpenProjectInfo(row.id);
                        }}><Glyph kind="info"/>Свойства проекта</a>
                        <button type="button" onClick={() => {
                            setOverlay(null);
                            onCompose(row.id);
                        }}><Glyph kind="plus"/>Новый тред</button>
                        <button type="button" onClick={() => {
                            onToggleHidden(row.id);
                            setOverlay(null);
                            search.current?.focus();
                        }}><Glyph kind={row.hidden ? 'eye' : 'eye-off'}/>
                            {row.hidden ? 'Вернуть в список' : 'Скрыть проект'}</button>
                        {projectActionLabels.map(({action, label, icon}) => <button key={action} type="button"
                            className={action === 'delete' ? 'catalog-destructive' : undefined} onClick={() => {
                                setOverlay(null);
                                setActionTarget({action, id: row.id, name: row.name});
                            }}><Glyph kind={icon}/>{label}</button>)}
                    </Overlay>
                </div>
                {expandedId === row.id && <CatalogThreads label={`Треды проекта ${row.name}`} threads={row.threads}
                    activeThreadId={activeThreadId} onOpen={onOpenThread}/>}
            </li>)}
        </ul>
        {actionTarget && <ProjectActionDialog target={actionTarget} onRun={onProjectAction}
            onPrepareMerge={onPrepareMerge} onClose={() => {
            setActionTarget(null);
            search.current?.focus();
        }}/>}
        {!visible.length && <p className="catalog-empty" role="status">Проекты не найдены</p>}
    </div>;
}
