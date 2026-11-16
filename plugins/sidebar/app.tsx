import { useEffect, useMemo, useState } from 'react';
import { definePluginApp, experimental_useSidebarThreads as useThreads, useSettings, useRpc, useBbNavigate, experimental_ThreadActionsContextMenu as ThreadMenu, experimental_ThreadActionsMenu as ActionsMenu, type PluginThreadListProps, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { toast } from 'sonner';
import type { contract } from './server';
import { buildProjectTree, type TreeNode, type ProjectLocation, type ThreadNode } from './src/core/tree';
import { sidebarPresentation, runningThreads, isRunning } from './src/core/presentation';
import { ThreadBranch } from './src/ui/thread-branch';
import { FoldSection } from './src/ui/fold-section';
import { useHidden, toggle } from './src/adapters/bb/preferences';
import './sidebar.css';
import { Glyph } from './src/ui/glyph';
function change(kind: 'projects' | 'threads', id: string) {
    try {
        toggle(kind, id);
    }
    catch {
        toast.error('Не удалось сохранить скрытие. Проверьте доступ к хранилищу браузера.');
    }
}
export default definePluginApp(app => {
    app.slots.experimental_threadList({ id: 'tree', title: 'Makosh Sidebar', component: Sidebar });
    app.slots.experimental_threadAction({ id: 'hide', title: 'Скрыть / вернуть', icon: 'Eye', group: 'organize',
        useData: () => useHidden(), item: ({ thread, data }) => ({ label: data.threads.includes(thread.id) ? 'Вернуть' : 'Скрыть', icon: 'Eye', run: () => change('threads', thread.id) }) });
});
function Sidebar({ activeThreadId, onNavigate }: PluginThreadListProps) {
    const { status, threads, projects } = useThreads();
    const hidden = useHidden();
    const [show, setShow] = useState(false);
    const [paths, setPaths] = useState<ProjectLocation[]>([]);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const rpc = useRpc<typeof contract>();
    const ids = projects.map(p => p.id).sort().join(',');
    useEffect(() => { let live = true; setError(false); rpc.call('paths', null).then(result => { if (live)
        setPaths(result); }).catch(() => { if (live)
        setError(true); }); return () => { live = false; }; }, [rpc, ids, retry]);
    const { values } = useSettings();
    const rootPath = typeof values?.rootPath === 'string' ? values.rootPath : '';
    const view = useMemo(() => sidebarPresentation(projects.map(p => ({...p,path:paths.find(x=>x.id===p.id)?.path??null})), threads, hidden, show, rootPath), [projects,threads,paths,hidden,show,rootPath]);
    const { tree } = view;
    const byId = new Map(threads.map(t => [t.id, t]));
    const renderRow = (item: ThreadNode['thread'], depth: number, toggleControl: React.ReactNode) => {
        const thread = byId.get(item.id);
        if (!thread) return null;
        const muted = hidden.threads.includes(thread.id) || hidden.projects.includes(thread.projectId);
        return <ThreadRow thread={thread} depth={depth} active={activeThreadId === thread.id} muted={muted} onNavigate={onNavigate} toggleControl={toggleControl}/>;
    };
    const renderThread = (node: ThreadNode, depth: number): React.ReactNode => <ThreadBranch key={node.thread.id} node={node} depth={depth} renderRow={renderRow}/>;
    return <div className="makosh-sidebar">
  <button className="hidden-toggle" aria-pressed={show} onClick={() => setShow(!show)}><Glyph kind="eye"/>{show ? 'Скрыть скрытое' : 'Показать скрытое'}</button>
  {error ? <p role="alert">Не удалось загрузить пути проектов. <button onClick={() => setRetry(x => x + 1)}>Повторить</button></p> : null}
  {status === 'loading' ? <p role="status">Загрузка…</p> : status === 'error' ? <p role="alert">Не удалось загрузить список.</p> : <>
   <FoldSection label="Без проекта" count={view.loose.length} running={view.loose.filter(isRunning).map(t=>renderThread({thread:t,children:[]},0))}>
    {view.loose.map(t=>renderThread({thread:t,children:[]},0))}
   </FoldSection>
   {view.running.map(t=>renderThread({thread:t,children:[]},0))}
   {tree.pinned.length > 0 ? <FoldSection label="Закреплённые" count={tree.pinned.length} running={runningThreads(tree.pinned).map(t=>renderThread({thread:t,children:[]},0))}>{tree.pinned.map(n=>renderThread(n,0))}</FoldSection> : null}
   {[...tree.roots, ...tree.unrooted].sort((a, b) => b.latestAttentionAt - a.latestAttentionAt || a.label.localeCompare(b.label)).map(node => <Branch key={node.key} node={node} depth={0} hidden={hidden.projects} renderThread={renderThread} onNavigate={onNavigate}/>)}
   {!tree.roots.length && !tree.unrooted.length && !tree.pinned.length ? <p role="status">Нет видимых проектов и чатов.</p> : null}
  </>}
 </div>;
}
function branchRunning(node: TreeNode): ThreadNode['thread'][] {
    return [...runningThreads(node.threads), ...node.children.flatMap(branchRunning)];
}
function Branch({ node, depth, hidden, renderThread, onNavigate }: {
    node: TreeNode;
    depth: number;
    hidden: string[];
    renderThread: (n: ThreadNode, d: number) => React.ReactNode;
    onNavigate: () => void;
}) {
    const navigate = useBbNavigate();
    const [open, setOpen] = useState(false);
    const project = node.project;
    const muted = project !== null && hidden.includes(project.id);
    const row = <div className={'tree-row' + (muted ? ' user-hidden' : '')} style={{ paddingLeft: 10 + depth * 14 }}>
  <button aria-expanded={open} onClick={() => setOpen(!open)}><Glyph kind={open ? 'open' : project ? 'project' : 'folder'}/><span className="label">{node.label.split('/').filter(Boolean).at(-1)}</span>{!open && node.threadCount > 0 ? <span className="count">{node.threadCount}</span> : null}</button>
  {project ? <button className="new-thread" aria-label={`Новый чат в ${project.name}`} onClick={() => { navigate.toCompose({ projectId: project.id }); onNavigate(); }}>+</button> : null}
 </div>;
    return <div>{project ? <ContextMenu.Root><ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="makosh-sidebar-menu"><ContextMenu.Item onSelect={() => change('projects', project.id)}>{muted ? 'Вернуть' : 'Скрыть'}</ContextMenu.Item><ContextMenu.Item onSelect={() => { navigate.toCompose({ projectId: project.id }); onNavigate(); }}>Новый чат</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root> : row}
 {open ? <>{node.threads.map(n => renderThread(n, depth + 1))}{node.children.map(child => <Branch key={child.key} node={child} depth={depth + 1} hidden={hidden} renderThread={renderThread} onNavigate={onNavigate}/>)}</> : branchRunning(node).map(thread=>renderThread({thread,children:[]},depth+1))}</div>;
}
function ThreadRow({ thread, depth, active, muted, onNavigate, toggleControl }: {
    toggleControl: React.ReactNode;
    thread: PluginSidebarThread;
    depth: number;
    active: boolean;
    muted: boolean;
    onNavigate: () => void;
}) {
    const navigate = useBbNavigate();
    const target = { ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null };
    return <ThreadMenu thread={target}><div className={'tree-row' + (active ? ' active' : '') + (muted ? ' user-hidden' : '')} style={{ paddingLeft: 10 + depth * 14 }}>
 {toggleControl}
 <a href={thread.href} aria-current={active ? 'page' : undefined} onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return; e.preventDefault(); navigate.toThread(thread.id); onNavigate(); }}><span title={thread.indicatorLabel ?? undefined}>{thread.status === 'active' ? '◉' : thread.isUnread ? '●' : '○'}</span><span className="label">{thread.displayTitle}</span></a>
 <ActionsMenu thread={target} trigger={props => <button {...props} className={[props.className,"thread-menu"].filter(Boolean).join(" ")} aria-label={`Действия: ${thread.displayTitle}`}>⋯</button>}/>
 </div></ThreadMenu>;
}
