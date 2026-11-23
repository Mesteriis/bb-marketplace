import {useEffect, useRef, useState, type MouseEvent, type ReactNode} from 'react';
import {filterCatalog, type CatalogRow, type CatalogSort} from '../core/project-catalog';
import {Glyph} from './glyph';
import './project-catalog.css';

type Props = {
    rows: readonly CatalogRow[];
    activeProjectId: string | null;
    projectless?: {id: string; href: string};
    onOpen: (id: string) => void;
    onCompose: (id: string) => void;
    onToggleHidden: (id: string) => void;
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
        <button type="button" ref={trigger} aria-label={label} aria-expanded={open} title={label}
            onClick={() => onOpenChange(!open)}>{icon}</button>
        {open && <div className="catalog-popover" role="group" aria-label={label}>{children}</div>}
    </div>;
}

function ProjectStatus({row}: {row: CatalogRow}) {
    const status =
        row.hidden ? {label: 'Скрыт', kind: 'muted'} :
        row.empty ? {label: 'Пустой', kind: 'muted'} :
        row.waiting ? {label: 'Ждёт ответа', kind: 'waiting'} :
        row.failed ? {label: 'Ошибка', kind: 'failed'} :
        row.running ? {label: `${row.running} в работе`, kind: 'running'} :
        row.unread ? {label: row.unread === 1 ? '1 новый ответ' : `${row.unread} новых`, kind: 'unread'} : null;
    return status && <span className={`catalog-status ${status.kind}`}>{status.label}</span>;
}

export function ProjectCatalog({rows, activeProjectId, projectless, onOpen, onCompose, onToggleHidden}: Props) {
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState('');
    const [sort, setSort] = useState<CatalogSort>('activity');
    const [showHidden, setShowHidden] = useState(false);
    const [showEmpty, setShowEmpty] = useState(false);
    const [overlay, setOverlay] = useState<{id: string} | 'visibility' | null>(null);
    const search = useRef<HTMLInputElement>(null);
    const scopes = [...new Set(rows.map(row => row.scope).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const selectedScope = scopes.includes(scope) ? scope : '';
    const visible = filterCatalog(rows, {query, scope: selectedScope, sort, showHidden, showEmpty});

    function openRow(event: MouseEvent<HTMLAnchorElement>, id: string) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(id);
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
        {projectless && <div className={`catalog-row catalog-projectless${projectless.id === activeProjectId ? ' selected' : ''}`}>
            <a href={projectless.href} aria-current={projectless.id === activeProjectId ? 'page' : undefined}
                onClick={event => openRow(event, projectless.id)}>
                <Glyph kind="inbox"/>
                Без проекта
            </a>
        </div>}
        <ul className="catalog-list" aria-label="Проекты">
            {visible.map(row => <li key={row.id} className={`catalog-row${row.id === activeProjectId ? ' selected' : ''}`}>
                <a href={row.href} aria-current={row.id === activeProjectId ? 'page' : undefined}
                    onClick={event => openRow(event, row.id)}>
                    <Glyph kind="project"/>
                    <span className="catalog-name" title={row.name}>{row.name}</span>
                    {row.folder && <span className="catalog-path" title={row.folder}>{row.folder}</span>}
                    <ProjectStatus row={row}/>
                </a>
                <Overlay label={`Действия проекта ${row.name}`} icon="⋯"
                    open={typeof overlay === 'object' && overlay?.id === row.id}
                    onOpenChange={open => setOverlay(open ? {id: row.id} : null)}>
                    <button type="button" onClick={() => {
                        onToggleHidden(row.id);
                        setOverlay(null);
                        search.current?.focus();
                    }}>{row.hidden ? 'Вернуть в список' : 'Скрыть проект'}</button>
                    <button type="button" onClick={() => {
                        setOverlay(null);
                        onCompose(row.id);
                    }}>Новый тред</button>
                </Overlay>
            </li>)}
        </ul>
        {!visible.length && <p className="catalog-empty" role="status">Проекты не найдены</p>}
    </div>;
}
