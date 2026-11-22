import { ThreadListLimit } from './src/ui/thread-list-limit';
import { useEffect, useMemo, useState } from 'react';
import { definePluginApp, experimental_useSidebarThreads as useThreads, useSettings, useRpc, useBbNavigate, experimental_ThreadActionsContextMenu as ThreadMenu, experimental_ThreadActionsMenu as ActionsMenu, type PluginThreadListProps, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { toast } from 'sonner';
import type { contract } from './server';
import { buildProjectTree, type TreeNode, type ProjectLocation, type ThreadNode } from './src/core/tree';
import { sidebarPresentation, runningThreads, isRunning,withBranchActivity } from './src/core/presentation';
import { activeThreads } from './src/core/active';
import { ThreadBranch } from './src/ui/thread-branch';
import { FoldSection } from './src/ui/fold-section';
import { useHidden, toggle } from './src/adapters/bb/preferences';
import './sidebar.css';
import { Glyph } from './src/ui/glyph';
import {ProgressProvider,ProgressNotice,useThreadPlans,useObserveThreadPlans,usePlanningAttention} from './src/adapters/bb/progress-context';
import {registerPlanningApp} from './src/adapters/bb/planning/app';
import {ThreadProgress,ProgressStyles} from './src/ui/thread-progress';
import {planLabels} from './src/core/progress';
import {attentionThreads,requiresAttention,waitingReason,searchProjects} from './src/core/work-status';
import {SidebarTabs,type SidebarTab} from './src/ui/sidebar-tabs';
import {useSidebarHeader} from './src/adapters/bb/sidebar-header';
import {ProgressFreshness} from './src/ui/progress-freshness';
function change(kind: 'projects' | 'threads', id: string) {
    try {
        toggle(kind, id);
    }
    catch {
        toast.error('Не удалось сохранить скрытие. Проверьте доступ к хранилищу браузера.');
    }
}
export default definePluginApp(app => {
    registerPlanningApp(app);
    app.slots.experimental_threadList({ id: 'tree', title: 'Makosh Sidebar', component: props=><ProgressProvider><Sidebar {...props}/></ProgressProvider> });
    app.slots.experimental_threadAction({ id: 'hide', title: 'Скрыть / вернуть', icon: 'Eye', group: 'organize',
        useData: () => useHidden(), item: ({ thread, data }) => ({ label: data.threads.includes(thread.id) ? 'Вернуть' : 'Скрыть', icon: 'Eye', run: () => change('threads', thread.id) }) });
});
function Sidebar({ activeThreadId, onNavigate }: PluginThreadListProps) {
    const navigate=useBbNavigate();
    const { status, threads:hostThreads, projects } = useThreads();
    const attention=usePlanningAttention();
    const threads=useMemo(()=>withBranchActivity(hostThreads).map(thread=>({...thread,planAttention:attention[thread.id]})),[hostThreads,attention]);
    useObserveThreadPlans(threads.filter(t=>!t.isHidden&&!t.isArchived&&isRunning(t)).map(t=>t.id));
    const hidden = useHidden();
    const [show, setShow] = useState(false);
    const [paths, setPaths] = useState<ProjectLocation[]>([]);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [filter,setFilter]=useState<'all'|'running'|'unread'|'attention'>('all');
    const [tab,setTab]=useState<SidebarTab>('now');
    const [projectQuery,setProjectQuery]=useState('');
    const [allAttention,setAllAttention]=useState(false);
    const headerAttached=useSidebarHeader(tab,setTab);
    const rpc = useRpc<typeof contract>();
    const ids = projects.map(p => p.id).sort().join(',');
    useEffect(() => { let live = true; setError(false); rpc.call('paths', null).then(result => { if (live)
        setPaths(result); }).catch(() => { if (live)
        setError(true); }); return () => { live = false; }; }, [rpc, ids, retry]);
    const { values } = useSettings();
    const rootPath = typeof values?.rootPath === 'string' ? values.rootPath : '';
    const threadLimit = typeof values?.threadLimit === 'number' && Number.isInteger(values.threadLimit) && values.threadLimit >= 1 && values.threadLimit <= 1000 ? values.threadLimit : 5;
    const view = useMemo(() => sidebarPresentation(projects.map(p => ({...p,path:paths.find(x=>x.id===p.id)?.path??null})), threads, hidden, show, rootPath), [projects,threads,paths,hidden,show,rootPath]);
    const { tree } = view;
    const active = useMemo(()=>activeThreads(threads,filter),[threads,filter]);
    const eligible=threads.filter(t=>!t.isHidden&&!t.isArchived);
    const attentionRows=attentionThreads(eligible);
    const byId = new Map(threads.map(t => [t.id, t]));
    const childrenByParent=new Map<string,PluginSidebarThread[]>();
    for(const thread of eligible)if(thread.parentThreadId){const bucket=childrenByParent.get(thread.parentThreadId)??[];bucket.push(thread);childrenByParent.set(thread.parentThreadId,bucket);}
    const renderRow = (item: ThreadNode['thread'], depth: number, toggleControl: React.ReactNode,node?:ThreadNode) => {
        const thread = byId.get(item.id);
        if (!thread) return null;
        const muted = hidden.threads.includes(thread.id) || hidden.projects.includes(thread.projectId);
        const descendants=(id:string,seen=new Set([id])):ThreadNode['thread'][]=>(childrenByParent.get(id)??[]).flatMap(child=>{
            if(seen.has(child.id))return [];seen.add(child.id);return [child,...descendants(child.id,seen)];
        });
        const children=node?descendants(thread.id):[];
        const running=children.filter(isRunning).length;
        const unread=children.filter(t=>t.isUnread).length;
        const waiting=children.filter(t=>t.hasPendingInteraction||t.planAttention==='needs_input').length;
        const errors=children.filter(t=>t.planAttention==='error').length;
        const summary=children.length?`Субтреды ${children.length}${running?` · в работе ${running}`:''}${unread?` · новые ${unread}`:''}${waiting?` · ждут ответа ${waiting}`:''}${errors?` · ошибки ${errors}`:''}`:undefined;
        const parent=thread.parentThreadId?byId.get(thread.parentThreadId):null;
        const context=depth===0?projects.find(p=>p.id===thread.projectId)?.name:!node&&parent?.parentThreadId?parent.displayTitle:undefined;
        return <ThreadRow thread={thread} depth={depth} context={context} summary={summary} reason={waitingReason(children)} attentionThreadId={attentionThreads(children).find(t=>t.planAttention==='error'||t.status==='error')?.id??attentionThreads(children)[0]?.id} descendants={children.map(t=>({id:t.id,parentThreadId:t.parentThreadId,title:byId.get(t.id)?.displayTitle??t.title??t.id}))} active={activeThreadId === thread.id} muted={muted} onNavigate={onNavigate} toggleControl={toggleControl}/>;
    };
    const renderThread = (node:ThreadNode,depth:number):React.ReactNode=><ThreadBranch key={node.thread.id} node={node} depth={depth} renderRow={renderRow}/>;
    const projectNodes=searchProjects([...tree.roots,...tree.unrooted],projectQuery);
    return <div className="makosh-sidebar">
  <ProgressStyles/>
  {!headerAttached?<SidebarTabs tab={tab} onChange={setTab} onCompose={()=>{navigate.toCompose({});onNavigate();}}/>:null}
  <ProgressNotice/>
  {error ? <p role="alert">Не удалось загрузить пути проектов. <button onClick={() => setRetry(x => x + 1)}>Повторить</button></p> : null}
  {status === 'loading' ? <p role="status">Загрузка…</p> : status === 'error' ? <p role="alert">Не удалось загрузить список.</p> : <>
   {tab==='now'?<div role="tabpanel" id="makosh-sidebar-panel-now" aria-labelledby="makosh-sidebar-tab-now"><section aria-label="Активные" className="active-groups">
    <div className="activity-filters" aria-label="Фильтр активности">
     <button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>Все</button>
     <button aria-pressed={filter==='running'} onClick={()=>setFilter('running')}><span className="status-dot running" aria-hidden="true"/>В работе <span>{eligible.filter(isRunning).length}</span></button>
     <button aria-pressed={filter==='unread'} onClick={()=>setFilter('unread')}><span className="status-dot unread" aria-hidden="true"/>Новые ответы <span>{eligible.filter(t=>t.isUnread).length}</span></button>
     <button aria-pressed={filter==='attention'} onClick={()=>setFilter('attention')}>Внимание <span>{attentionRows.length}</span></button>
    </div>
    {attentionRows.length?<section className="attention-inbox" aria-label="Требует внимания"><div className="attention-heading">Требует внимания <span>{attentionRows.length}</span></div>{(allAttention?attentionRows:attentionRows.slice(0,8)).map(thread=><AttentionRow key={thread.id} thread={thread} onNavigate={onNavigate}/>)}{attentionRows.length>8?<button className="attention-more" onClick={()=>setAllAttention(!allAttention)}>{allAttention?'Свернуть':`Ещё ${attentionRows.length-8}`}</button>:null}</section>:null}
    {active.map(node=><ThreadBranch key={node.thread.id} node={node} depth={0} renderRow={renderRow} initialCollapsed/>)}
    {!active.length?<p className="empty-activity">{filter==='running'?'Нет работающих тредов':filter==='unread'?'Нет новых ответов':filter==='attention'?'Нет тредов, требующих внимания':'Нет текущей активности'}</p>:null}
   </section></div>:<div role="tabpanel" id="makosh-sidebar-panel-projects" aria-labelledby="makosh-sidebar-tab-projects"><label className="project-search"><Glyph kind="folder"/><input aria-label="Найти проект" placeholder="Найти проект" value={projectQuery} onChange={event=>setProjectQuery(event.target.value)}/></label>
   {!projectQuery.trim()?<><FoldSection label="Без проекта" count={view.loose.length} running={view.loose.filter(isRunning).map(t=>renderThread({thread:t,children:[]},0))}>
    {view.loose.map(t=>renderThread({thread:t,children:[]},0))}
   </FoldSection>
   {view.running.map(t=>renderThread({thread:t,children:[]},0))}
   {tree.pinned.length > 0 ? <FoldSection label="Закреплённые" count={tree.pinned.length} running={runningThreads(tree.pinned).map(t=>renderThread({thread:t,children:[]},0))}>{tree.pinned.map(n=>renderThread(n,0))}</FoldSection> : null}
   </>:null}
   {projectNodes.sort((a, b) => b.latestAttentionAt - a.latestAttentionAt || a.label.localeCompare(b.label)).map(node => <Branch key={node.key} node={node} depth={0} hidden={hidden.projects} threadLimit={threadLimit} renderThread={renderThread} onNavigate={onNavigate}/>)}
   {!projectNodes.length&&(!tree.pinned.length||!!projectQuery)?<p role="status">{projectQuery?'Проекты не найдены':'Нет видимых проектов и чатов.'}</p>:null}
   <button className="hidden-toggle" aria-pressed={show} onClick={() => setShow(!show)}><Glyph kind="eye"/>{show ? 'Скрыть скрытое' : 'Показать скрытое'}</button></div>}
  </>}
 </div>;
}
function branchRunning(node: TreeNode): ThreadNode['thread'][] {
    return [...runningThreads(node.threads), ...node.children.flatMap(branchRunning)];
}
function Branch({ node, depth, hidden, threadLimit, renderThread, onNavigate }: {
    node: TreeNode;
    depth: number;
    hidden: string[];
    threadLimit: number;
    renderThread: (n: ThreadNode, d: number) => React.ReactNode;
    onNavigate: () => void;
}) {
    const navigate = useBbNavigate();
    const [open, setOpen] = useState(false);
    const project = node.project;
    const muted = project !== null && hidden.includes(project.id);
    const row = <div className={'tree-row' + (muted ? ' user-hidden' : '')} style={{ paddingLeft: 10 + depth * 14 }}>
  <button className="project-toggle" aria-expanded={open} title={node.label} onClick={() => setOpen(!open)}><Glyph kind={open ? 'open' : project ? 'project' : 'folder'}/><span className="label">{project?.name??node.label}</span>{!open && node.threadCount > 0 ? <span className="count">{node.threadCount}</span> : null}</button>
  {project ? <button className="new-thread" aria-label={`Новый чат в ${project.name}`} onClick={() => { navigate.toCompose({ projectId: project.id }); onNavigate(); }}>+</button> : null}
 </div>;
    return <div>{project ? <ContextMenu.Root><ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="makosh-sidebar-menu"><ContextMenu.Item onSelect={() => change('projects', project.id)}>{muted ? 'Вернуть' : 'Скрыть'}</ContextMenu.Item><ContextMenu.Item onSelect={() => { navigate.toCompose({ projectId: project.id }); onNavigate(); }}>Новый чат</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root> : row}
 {open ? <><ThreadListLimit rows={node.threads.map(n => renderThread(n, depth + 1))} limit={threadLimit} depth={depth+1}/>{node.children.map(child => <Branch key={child.key} node={child} depth={depth + 1} hidden={hidden} threadLimit={threadLimit} renderThread={renderThread} onNavigate={onNavigate}/>)}</> : branchRunning(node).map(thread=>renderThread({thread,children:[]},depth+1))}</div>;
}
function ThreadRow({ thread, depth, active, muted, onNavigate, toggleControl,context,summary,descendants=[],reason,attentionThreadId }: {
    reason?:string;attentionThreadId?:string;
    descendants?:{id:string;parentThreadId:string|null;title:string}[];
    context?:string;summary?:string;
    toggleControl: React.ReactNode;
    thread: PluginSidebarThread;
    depth: number;
    active: boolean;
    muted: boolean;
    onNavigate: () => void;
}) {
    const navigate = useBbNavigate();
    const {plans,failed,checkedAt,refresh}=useThreadPlans(thread.id,descendants);
    const {values}=useSettings();
    const plan=plans[0];
    const planAttention=plan?.state==='needs_input'||plan?.state==='error';
    const badge=thread.hasPendingInteraction?'Нужен ответ':planAttention?planLabels[plan.state]:thread.status==='error'?'Ошибка':isRunning(thread)?(thread.status==='stopping'?'Останавливается':thread.status==='starting'?'Запускается':'В работе'):thread.isUnread?'Новый ответ':plan?.state==='done'?'План готов':null;
    const badgeState=thread.hasPendingInteraction?'needs_input':planAttention?plan.state:thread.status==='error'?'error':isRunning(thread)?'running':thread.isUnread?'unread':plan?.state;
    const openAttention=()=>{navigate.toThread(thread.hasPendingInteraction?thread.id:attentionThreadId??thread.id);onNavigate();};
    const target = { ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null };
    const indent=26+Math.min(depth,3)*14;
    return <ThreadMenu thread={target}><div className={'thread-item' + (active ? ' active' : '') + (muted ? ' user-hidden' : '')} style={{'--thread-indent':`${indent}px`} as React.CSSProperties}><div className="tree-row thread-row" style={{paddingLeft:indent}}>
 {toggleControl}
 <a href={thread.href} aria-current={active ? 'page' : undefined} onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return; e.preventDefault(); navigate.toThread(thread.id); onNavigate(); }}><span title={thread.indicatorLabel ?? undefined} className={`status-dot ${isRunning(thread)?'running':thread.isUnread?'unread':'quiet'}`} aria-hidden="true"/><span className="thread-copy">{context||summary?<span className="thread-meta">{context?<span className="thread-context">{context}</span>:null}{summary?<span className="subthread-summary-inline">{summary}</span>:null}</span>:null}<span className="label">{thread.displayTitle}</span>{reason?<span className="thread-waiting">{reason}</span>:null}</span>{thread.isUnread&&badgeState!=='unread'?<span className="status-dot unread" role="img" aria-label="Новый ответ"/>:null}{!plans.length&&badge?<span className={`state-badge plan-${badgeState}`}>{badge}</span>:null}</a>
 <ActionsMenu thread={target} trigger={props => <button {...props} className={[props.className,"thread-menu"].filter(Boolean).join(" ")} aria-label={`Действия: ${thread.displayTitle}`}>⋯</button>}/>
 </div><ThreadProgress plans={plans} effects={values?.effects!==false} status={badge&&badgeState?{label:badge,state:badgeState,onActivate:badgeState==='needs_input'||badgeState==='error'?openAttention:undefined}:undefined}/><div className="thread-progress-meta">{plans.length||isRunning(thread)||failed?<ProgressFreshness updatedAt={plan?.updatedAt} checkedAt={checkedAt} failed={!!failed} running={isRunning(thread)} onRefresh={refresh}/>:null}</div></div></ThreadMenu>;
}

function AttentionRow({thread,onNavigate}:{thread:PluginSidebarThread&{planAttention?:'needs_input'|'error'};onNavigate:()=>void}) {
 const navigate=useBbNavigate();
 const {plans}=useThreadPlans(thread.id);
 const question=thread.hasPendingInteraction||thread.planAttention==='needs_input';
 const plan=plans.find(p=>p.state===(question?'needs_input':'error'));
 return <a className={'attention-item '+(question?'needs-input':'error')} href={thread.href} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate.toThread(thread.id);onNavigate();}}><span aria-hidden="true">{question?'?':'!'}</span><span><strong>{thread.displayTitle}</strong><small>{plan?.note??(question?'Нужен твой ответ':'Ошибка выполнения')}</small></span><span aria-hidden="true">↗</span></a>;
}
