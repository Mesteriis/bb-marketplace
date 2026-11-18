import React, { useEffect, useRef, useState } from 'react';
import type { LayoutNode, NavigationBadge } from '../core/model';
export function NavigationRail({ nodes, labels, onActivate, onHome, icon, activeId, badges = {}, disabledIds = [], homeIcon, homeActive = false }: {
    homeIcon?: React.ReactNode;
    homeActive?: boolean;
    nodes: LayoutNode[];
    labels: Record<string, string>;
    onActivate: (id: string, split: boolean) => void;
    onHome: () => void;
    icon?: (n: LayoutNode) => React.ReactNode;
    activeId?: string | null;
    badges?: Record<string, NavigationBadge>;
    disabledIds?: string[];
}) {
    const [path, setPath] = useState<string[]>([]), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
    function locate(list: LayoutNode[], id: string): LayoutNode | undefined { for (const n of list) {
        if (n.id === id)
            return n;
        if (n.kind === 'group') {
            const found = locate(n.children, id);
            if (found)
                return found;
        }
    } }
    const popup = useRef<HTMLDivElement>(null), previousPath = useRef<string[]>([]);
    const group = locate(nodes, path.at(-1) ?? '');
    useEffect(() => { const previous = previousPath.current; previousPath.current = path; if (!path.length)
        return; const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button[data-node-id]:not(:disabled)') ?? []); const restored = previous.length > path.length ? buttons.find(b => b.dataset.nodeId === previous.at(-1)) : null; (restored ?? buttons[0] ?? popup.current?.querySelector<HTMLButtonElement>('header button'))?.focus(); }, [path]);
    function hasBadge(n: LayoutNode): boolean { return n.kind === 'item' ? !!badges[n.itemId] : n.kind === 'group' && n.children.some(hasBadge); }
    function close() { setPath([]); trigger.current?.focus(); }
    useEffect(() => { function outside(e: PointerEvent) { if (path.length && !root.current?.contains(e.target as Node))
        setPath([]); } document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside); }, [path.length]);
    useEffect(() => { if (path.length && !group)
        setPath([]); }, [nodes, group, path.length]);
    function contains(n: LayoutNode): boolean { return n.kind === 'item' ? n.itemId === activeId : n.kind === 'group' && n.children.some(contains); }
    function badgeLabel(n:LayoutNode):string { return n.kind==='item' ? badges[n.itemId]?.label ?? '' : hasBadge(n) ? 'есть уведомления' : ''; }
    function badgeValue(n:LayoutNode,rail:boolean):string {if(n.kind!=='item')return '●';const badge=badges[n.itemId];if(badge?.count!==undefined&&Number.isFinite(badge.count)&&badge.count>0){const cap=rail?9:99;return badge.count>cap?cap+'+':String(Math.floor(badge.count));}return !rail&&badge?.text?badge.text.slice(0,8):'●';}
    function button(n: LayoutNode, rail: boolean) { return n.kind === 'separator' ? <hr key={n.id}/> : <button type="button" key={n.id} data-node-id={n.id} disabled={n.kind === 'item' && disabledIds.includes(n.itemId)} title={(n.kind === 'group' ? n.name : labels[n.itemId]) + (hasBadge(n) ? ', '+badgeLabel(n) : '')} aria-label={(n.kind === 'group' ? n.name : labels[n.itemId]) + (hasBadge(n) ? ', '+badgeLabel(n) : '')} aria-current={contains(n) ? 'page' : undefined} onClick={e => { if (n.kind === 'group') {
        if (rail) {
            trigger.current = e.currentTarget;
            setPath(path[0] === n.id ? [] : [n.id]);
        }
        else
            setPath([...path, n.id]);
    }
    else {
        onActivate(n.itemId, e.ctrlKey || e.metaKey);
        setPath([]);
    } }}>{icon?.(n) ?? (n.kind === 'group' ? '▦' : '◇')}{!rail && <span>{n.kind === 'group' ? n.name : labels[n.itemId] ?? n.itemId}</span>}{hasBadge(n) && <span className={"nav-badge"+(badgeValue(n,rail)==='●'?' nav-badge-dot':'')} aria-hidden="true" aria-label="Есть уведомления">{badgeValue(n,rail)}</span>}{!rail && n.kind === 'group' && ' ›'}</button>; }
    return <div className="nav-root" ref={root} onKeyDown={e => { if (e.key === 'Escape') {
        e.stopPropagation();
        if (path.length > 1)
            setPath(path.slice(0, -1));
        else
            close();
    } }}><nav className="nav-rail" aria-label="Навигация"><button type="button" aria-label="Главная" title="Главная" aria-current={homeActive ? 'page' : undefined} onClick={onHome}>{homeIcon ?? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10 12 3 21 10V21H15V14H9V21H3Z"/></svg>}</button>{nodes.map(n => button(n, true))}</nav>{group?.kind === 'group' && <div ref={popup} className="nav-popup" role="dialog" aria-label={group.name}><header>{path.length > 1 ? <button type="button" onClick={() => setPath(path.slice(0, -1))}>Назад</button> : <button type="button" onClick={close} aria-label="Закрыть">×</button>}<strong>{group.name}</strong></header>{group.children.map(n => button(n, false))}{!group.children.some(n => n.kind !== 'separator') && <p>В группе пока нет видимых пунктов</p>}</div>}</div>;
}
