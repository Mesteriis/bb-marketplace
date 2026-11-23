import { useEffect, useMemo, useState } from 'react';
import { definePluginApp, experimental_useSidebarThreads as useThreads, useSettings, useRpc, useBbNavigate, experimental_ThreadActionsContextMenu as ThreadMenu, experimental_ThreadActionsMenu as ActionsMenu, type PluginThreadListProps, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { contract } from './server';
import type { ProjectLocation, ThreadNode } from './src/core/tree';
import { isRunning,withBranchActivity } from './src/core/presentation';
import { todayScope, todayThreads, TODAY_WINDOW_MS } from './src/core/active';
import { ThreadBranch } from './src/ui/thread-branch';
import { useHidden, toggle } from './src/adapters/bb/preferences';
import './sidebar.css';
import {ProgressProvider,ProgressNotice,useThreadPlans,useObserveThreadPlans,usePlanningAttention} from './src/adapters/bb/progress-context';
import {registerPlanningApp} from './src/adapters/bb/planning/app';
import {ProgressLifecycle} from './src/adapters/bb/planning/progress-lifecycle';
import {ThreadProgress,ThreadPlanHistory,ProgressStyles} from './src/ui/thread-progress';
import {planLabels} from './src/core/progress';
import {attentionThreads,waitingReason} from './src/core/work-status';
import {SidebarTabs,type SidebarTab} from './src/ui/sidebar-tabs';
import {useSidebarHeader} from './src/adapters/bb/sidebar-header';
import {ProgressFreshness} from './src/ui/progress-freshness';
import {requestChertogTile} from './src/adapters/bb/chertog-open';
import {buildCatalog, isCatalogParent} from './src/core/project-catalog';
import {ProjectCatalog} from './src/ui/project-catalog';
import {ProjectInfoPanel, projectInfoHref, projectInfoPath} from './src/adapters/bb/project-info';

function change(kind: 'catalogProjects' | 'threads', id: string) {
    try {
        toggle(kind, id);
    }
    catch {
        toast.error('Не удалось сохранить скрытие. Проверьте доступ к хранилищу браузера.');
    }
}
export default definePluginApp(app => {
    registerPlanningApp(app);
    app.slots.navPanel({id: 'project-info', path: projectInfoPath, title: 'Свойства проекта',
        icon: 'FolderGit', component: ProjectInfoPanel});
    app.slots.experimental_threadList({ id: 'tree', title: 'Makosh Sidebar', component: props=><ProgressProvider><Sidebar {...props}/></ProgressProvider> });
    app.slots.experimental_threadAction({ id: 'hide', title: 'Скрыть / вернуть', icon: 'Eye', group: 'organize',
        useData: () => useHidden(), item: ({ thread, data }) => ({ label: data.threads.includes(thread.id) ? 'Вернуть' : 'Скрыть', icon: 'Eye', run: () => change('threads', thread.id) }) });
});
function Sidebar({ activeThreadId, activeProjectId, onNavigate }: PluginThreadListProps) {
    const navigate=useBbNavigate();
    const { status, threads:hostThreads, projects } = useThreads();
    const attention=usePlanningAttention();
    const threadsWithAttention=useMemo(()=>hostThreads.map(thread=>({...thread,planAttention:attention[thread.id]})),[hostThreads,attention]);
    const threads=useMemo(()=>withBranchActivity(threadsWithAttention),[threadsWithAttention]);
    useObserveThreadPlans(threads.filter(t=>!t.isHidden&&!t.isArchived&&isRunning(t)).map(t=>t.id));
    const hidden = useHidden();
    const catalogHidden = hidden.catalogProjects ?? hidden.projects;
    const [paths, setPaths] = useState<ProjectLocation[]>([]);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [filter,setFilter]=useState<'all'|'running'|'unread'|'attention'>('all');
    const [tab,setTab]=useState<SidebarTab>('now');
    const [allAttention,setAllAttention]=useState(false);
    const headerAttached=useSidebarHeader(tab,setTab);
    const rpc = useRpc<typeof contract>();
    const ids = projects.map(p => p.id).sort().join(',');
    useEffect(() => { let live = true; setError(false); rpc.call('paths', null).then(result => { if (live)
        setPaths(result); }).catch(() => { if (live)
        setError(true); }); return () => { live = false; }; }, [rpc, ids, retry]);
    const { values } = useSettings();
    const rootPath = typeof values?.rootPath === 'string' ? values.rootPath : '';
    const projectless = useMemo(() => {
        if (tab !== 'projects') return undefined;
        const personal = projects.find(project => project.isPersonal);
        return personal && {id: personal.id, threads: threadsWithAttention.filter(thread =>
            thread.projectId === personal.id && isCatalogParent(thread))};
    }, [tab, projects, threadsWithAttention]);
    const catalog = useMemo(() => {
        if (tab !== 'projects') return [];
        const locations = new Map(paths.map(({id, path}) => [id, path]));
        return buildCatalog(projects.map(project => ({...project, infoHref: projectInfoHref(project.id), path: locations.get(project.id) ?? null})),
            threadsWithAttention, rootPath, catalogHidden);
    }, [tab, projects, paths, threadsWithAttention, rootPath, catalogHidden]);
    const [, refreshToday] = useState(0);
    const {recent, withAncestors} = todayScope(threadsWithAttention, Date.now());
    const today = withBranchActivity(withAncestors);
    const recentIds = new Set(recent.map(thread => thread.id));
    const recentRows = today.filter(thread => recentIds.has(thread.id));
    const nextExpiry = recent.reduce((next, thread) =>
        Math.min(next, thread.createdAt + TODAY_WINDOW_MS + 1), Infinity);
    useEffect(() => {
        if (tab !== 'now' || !Number.isFinite(nextExpiry)) return;
        const timer = setTimeout(() => refreshToday(value => value + 1), Math.max(0, nextExpiry - Date.now()));
        return () => clearTimeout(timer);
    }, [tab, nextExpiry]);
    const todayRows = todayThreads(today,filter,recentIds);
    const attentionRows=attentionThreads(recentRows);
    const byId = new Map(today.map(t => [t.id, t]));
    const childrenByParent=new Map<string,PluginSidebarThread[]>();
    for(const thread of today)if(thread.parentThreadId){const bucket=childrenByParent.get(thread.parentThreadId)??[];bucket.push(thread);childrenByParent.set(thread.parentThreadId,bucket);}
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
    return <div className="makosh-sidebar">
  <ProgressStyles/>
  <ProgressLifecycle threadId={activeThreadId}/>
  {!headerAttached?<SidebarTabs tab={tab} onChange={setTab} onCompose={()=>{navigate.toCompose({});onNavigate();}}/>:null}
  <ProgressNotice/>
  {error ? <p role="alert">Не удалось загрузить пути проектов. <button onClick={() => setRetry(x => x + 1)}>Повторить</button></p> : null}
  {status === 'loading' ? <p role="status">Загрузка…</p> : status === 'error' ? <p role="alert">Не удалось загрузить список.</p> : <>
   {tab==='now'?<div role="tabpanel" id="makosh-sidebar-panel-now" aria-labelledby="makosh-sidebar-tab-now"><section aria-label="Треды за последние 24 часа" className="active-groups">
    <div className="activity-filters" aria-label="Фильтр активности">
     <button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>Все</button>
     <button aria-pressed={filter==='running'} onClick={()=>setFilter('running')}><span className="status-dot running" aria-hidden="true"/>В работе <span>{recentRows.filter(isRunning).length}</span></button>
     <button aria-pressed={filter==='unread'} onClick={()=>setFilter('unread')}><span className="status-dot unread" aria-hidden="true"/>Новые ответы <span>{recentRows.filter(t=>t.isUnread).length}</span></button>
     <button aria-pressed={filter==='attention'} onClick={()=>setFilter('attention')}>Внимание <span>{attentionRows.length}</span></button>
    </div>
    {attentionRows.length?<section className="attention-inbox" aria-label="Требует внимания"><div className="attention-heading">Требует внимания <span>{attentionRows.length}</span></div>{(allAttention?attentionRows:attentionRows.slice(0,8)).map(thread=><AttentionRow key={thread.id} thread={thread} onNavigate={onNavigate}/>)}{attentionRows.length>8?<button className="attention-more" onClick={()=>setAllAttention(!allAttention)}>{allAttention?'Свернуть':`Ещё ${attentionRows.length-8}`}</button>:null}</section>:null}
    {todayRows.map(node=><ThreadBranch key={node.thread.id} node={node} depth={0} renderRow={renderRow} initialCollapsed/>)}
    {!todayRows.length?<p className="empty-activity">{filter==='running'?'Нет работающих тредов':filter==='unread'?'Нет новых ответов':filter==='attention'?'Нет тредов, требующих внимания':'Нет тредов за последние 24 часа'}</p>:null}
   </section></div>:<div role="tabpanel" id="makosh-sidebar-panel-projects" aria-labelledby="makosh-sidebar-tab-projects">
    <ProjectCatalog rows={catalog} activeProjectId={activeProjectId} activeThreadId={activeThreadId}
        projectless={projectless}
        onOpenThread={(id, split) => {
            if (split) navigate.toThread(id, {split: true});
            else {
                if (!requestChertogTile(id)) navigate.toThread(id);
                onNavigate();
            }
        }}
        onCompose={id => { navigate.toCompose({projectId: id}); onNavigate(); }}
        onOpenProjectInfo={id => { navigate.toPluginPanel(projectInfoPath, {subPath: id}); onNavigate(); }}
        onToggleHidden={id => change('catalogProjects', id)}/>
   </div>}
  </>}
 </div>;
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
    const running=isRunning(thread);
    const [historyOpen,setHistoryOpen]=useState(false);
    useEffect(()=>{if(running)setHistoryOpen(false);},[running]);
    const attentionPlan=plans.find(item=>item.state==='needs_input'||item.state==='error');
    const attentionState=thread.hasPendingInteraction?'needs_input':thread.status==='error'?'error':(attentionPlan?.state==='error'?'error':attentionPlan?'needs_input':null);
    const attentionNote=plans.find(item=>item.state===attentionState&&item.note)?.note??reason;
    const badgeState=attentionState??(running?'running':thread.isUnread?'unread':null);
    const badge=attentionState?(thread.status==='error'&&attentionState==='error'?'Ошибка':planLabels[attentionState]):
        running?(thread.status==='stopping'?'Останавливается':thread.status==='starting'?'Запускается':'В работе'):
        thread.isUnread?'Новый ответ':null;
    const showTrack=running&&plans.some(item=>item.state!=='done');
    const showHistory=!running&&plans.length>0;
    const showDetails=showHistory&&historyOpen;
    const openAttention=()=>{const id=thread.hasPendingInteraction?thread.id:attentionThreadId??thread.id;if(!requestChertogTile(id))navigate.toThread(id);onNavigate();};
    const target = { ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null };
    const indent=26+Math.min(depth,3)*14;
    return <ThreadMenu thread={target}><div className={'thread-item' + (active ? ' active' : '') + (muted ? ' user-hidden' : '')} style={{'--thread-indent':`${indent}px`} as React.CSSProperties}><div className="tree-row thread-row" style={{paddingLeft:indent}}>
 {toggleControl}
 <a href={thread.href} aria-current={active ? 'page' : undefined} onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return; e.preventDefault(); if(!requestChertogTile(thread.id))navigate.toThread(thread.id); onNavigate(); }}><span title={thread.indicatorLabel ?? undefined} className={`status-dot ${running?'running':thread.isUnread?'unread':'quiet'}`} aria-hidden="true"/><span className="thread-copy">{context||summary?<span className="thread-meta">{context?<span className="thread-context">{context}</span>:null}{summary?<span className="subthread-summary-inline">{summary}</span>:null}</span>:null}<span className="label">{thread.displayTitle}</span>{attentionNote?<span className="thread-waiting">{attentionNote}</span>:null}</span>{thread.isUnread&&badgeState!=='unread'?<span className="status-dot unread" role="img" aria-label="Новый ответ"/>:null}{!attentionState&&!showTrack&&badge?<span className={`state-badge plan-${badgeState}`}>{badge}</span>:null}</a>
 {attentionState?<button type="button" className={`state-badge plan-${attentionState}`} onClick={openAttention}>{badge} ↗</button>:null}
 {showHistory?<button type="button" className="plan-history-toggle" aria-label={`План: ${thread.displayTitle}`} title={historyOpen?'Скрыть план':'Показать план'} aria-expanded={historyOpen} onClick={()=>setHistoryOpen(open=>!open)}><span aria-hidden="true">{historyOpen?'▾':'▸'}</span></button>:null}
 <ActionsMenu thread={target} trigger={props => <button {...props} className={[props.className,"thread-menu"].filter(Boolean).join(" ")} aria-label={`Действия: ${thread.displayTitle}`}>⋯</button>}/>
 </div>
 {running?<ThreadProgress plans={plans} effects={values?.effects!==false} status={!attentionState&&badge&&badgeState?{label:badge,state:badgeState}:undefined}/>:null}
 {showDetails?<ThreadPlanHistory plans={plans}/>:null}
 {running||showDetails?<div className="thread-progress-meta"><ProgressFreshness updatedAt={plan?.updatedAt} checkedAt={checkedAt} failed={!!failed} running={running} onRefresh={refresh}/></div>:null}
 </div></ThreadMenu>;
}

function AttentionRow({thread,onNavigate}:{thread:PluginSidebarThread&{planAttention?:'needs_input'|'error'};onNavigate:()=>void}) {
 const navigate=useBbNavigate();
 const {plans}=useThreadPlans(thread.id);
 const question=thread.hasPendingInteraction||thread.planAttention==='needs_input';
 const plan=plans.find(p=>p.state===(question?'needs_input':'error'));
 return <a className={'attention-item '+(question?'needs-input':'error')} href={thread.href} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(!requestChertogTile(thread.id))navigate.toThread(thread.id);onNavigate();}}><span aria-hidden="true">{question?'?':'!'}</span><span><strong>{thread.displayTitle}</strong><small>{plan?.note??(question?'Нужен твой ответ':'Ошибка выполнения')}</small></span><span aria-hidden="true">↗</span></a>;
}
