import React, { useState } from 'react';
import type { LayoutNode } from '../core/model';
import { moveNode, removeContainer, setHidden } from '../core/tree';
export function LayoutEditor({ nodes, labels, onChange, resetNodes }: {
    nodes: LayoutNode[];
    labels: Record<string, string>;
    onChange: (nodes: LayoutNode[]) => void;
    resetNodes?: LayoutNode[];
}) {
    const [query, setQuery] = useState(''), [confirmReset, setConfirmReset] = useState(false);
    const [selected, select] = useState<string | null>(null), [error, setError] = useState('');
    function update(id: string, change: (n: LayoutNode) => LayoutNode) { const visit = (list: LayoutNode[]): LayoutNode[] => list.map(n => n.id === id ? change(n) : n.kind === 'group' ? { ...n, children: visit(n.children) } : n); onChange(visit(nodes)); }
    const groups: {
        id: string;
        name: string;
    }[] = [];
    function collect(list: LayoutNode[]) { for (const n of list)
        if (n.kind === 'group') {
            groups.push({ id: n.id, name: n.name });
            collect(n.children);
        } }
    collect(nodes);
    function add(kind: 'group' | 'separator') {
        const n: LayoutNode = kind === 'group' ? { kind, id: crypto.randomUUID(), hidden: false, name: 'Новая группа', icon: 'Folder', children: [] } : { kind, id: crypto.randomUUID(), hidden: false };
        if (selected && groups.some(g => g.id === selected))
            update(selected, g => g.kind === 'group' ? { ...g, children: [...g.children, n] } : g);
        else
            onChange([...nodes, n]);
    }
    function move(id: string, parent: string | null, index: number) { const result = moveNode(nodes, id, parent, index); if (result.ok) {
        setError('');
        onChange(result.nodes);
    }
    else
        setError('Нельзя переместить элемент в это место'); }
    function rows(list: LayoutNode[], parent: string | null, depth: number): React.ReactNode {
        return list.map((n, index) => {
            const label = n.kind === 'group' ? n.name : n.kind === 'item' ? (labels[n.itemId] ?? n.itemId) : 'Разделитель';
            return <React.Fragment key={n.id}><div className={'nav-editor-row ' + (n.hidden ? 'is-hidden' : '')} style={{ paddingLeft: depth * 18 + 8 }} draggable onDragStart={e => { e.dataTransfer.setData('text/plain', n.id); e.stopPropagation(); }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); move(e.dataTransfer.getData('text/plain'), parent, index); }}>
 <button type="button" aria-pressed={selected === n.id} onClick={() => select(n.id)}>{n.kind === 'group' ? '▸ ' : ''}{label}</button>
 <input type="checkbox" aria-label={'Показывать ' + label} checked={!n.hidden} onChange={e => { const r = setHidden(nodes, n.id, !e.target.checked); if (r.ok)
                onChange(r.nodes); }}/>
 <button type="button" aria-label={'Выше ' + label} disabled={index === 0} onClick={() => move(n.id, parent, index - 1)}>↑</button><button type="button" aria-label={'Ниже ' + label} disabled={index === list.length - 1} onClick={() => move(n.id, parent, index + 1)}>↓</button>
 <label className="nav-destination">В <select aria-label={'Переместить ' + label} value={parent ?? ''} onChange={e => move(n.id, e.target.value || null, 0)}><option value="">Корень</option>{groups.filter(g => g.id !== n.id).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
 {n.kind !== 'item' && <button type="button" aria-label={'Удалить ' + label} onClick={() => { const r = removeContainer(nodes, n.id); if (r.ok)
                onChange(r.nodes); }}>×</button>}
 </div>{n.kind === 'group' && <>{selected === n.id && <div className="nav-properties"><label>Название<input value={n.name} maxLength={160} onChange={e => update(n.id, g => ({ ...g, name: e.target.value }))}/></label><label>Поиск иконок<input value={query} onChange={e => setQuery(e.target.value)}/></label><label>Иконка<select aria-label="Иконка" value={n.icon} onChange={e => update(n.id, g => ({ ...g, icon: e.target.value }))}>{['Folder', 'Mail', 'Code', 'Briefcase', 'Star', 'Layers', 'MessageSquare', 'Settings'].filter(icon => icon.toLowerCase().includes(query.toLowerCase())).map(icon => <option key={icon}>{icon}</option>)}</select></label></div>}{rows(n.children, n.id, depth + 1)}</>}</React.Fragment>;
        });
    }
    return <section className="nav-editor"><h2>Панель навигации</h2><p>Одна раскладка для установки BB. Изменения сохраняются автоматически.</p><div className="nav-tools"><button type="button" onClick={() => add('group')}>＋ Группа</button><button type="button" onClick={() => add('separator')}>＋ Разделитель</button></div>{resetNodes && <button type="button" onClick={() => setConfirmReset(true)}>Сбросить раскладку</button>}{confirmReset && <div role="alertdialog" aria-label="Сброс раскладки"><p>Удалить группы и вернуть плоский список пунктов BB?</p><button type="button" onClick={() => { if (resetNodes)
        onChange(structuredClone(resetNodes)); setConfirmReset(false); }}>Подтвердить сброс</button><button type="button" onClick={() => setConfirmReset(false)}>Отмена</button></div>}{error && <p role="alert">{error}</p>}<div className="nav-editor-tree">{rows(nodes, null, 0)}</div><p>Выберите группу для изменения названия и иконки. Скрытые элементы сохраняют своё место.</p></section>;
}
