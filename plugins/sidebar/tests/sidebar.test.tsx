// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { act, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import app from '../app';
afterEach(() => { cleanup(); localStorage.clear(); });
 const make=(id:string,projectId:string,status:'active'|'idle'|'error')=>({id,projectId,status,title:id,titleFallback:null,parentThreadId:null,parentNotifications:"auto" as const,lifecycleOwnerThreadId:null,sourceThreadId:null,sectionId:null,originKind:null,originPluginId:null,providerId:"test",pinnedAt:null,archivedAt:null,createdAt:1,updatedAt:1,lastReadAt:null,hasPendingInteraction:false,isUnread:false,isPinned:false,pinSortKey:null,isArchived:false,displayTitle:id,href:'/projects/'+projectId+'/threads/'+id,environment:null,host:null,isHidden:false,indicator:'none' as const,indicatorLabel:null,runtimeStatus:status,queuedWork:'none' as const,activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:0},latestAttentionAt:100});
test('hidden project disappears, is revealed by the top toggle and can be restored', async () => {
    const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
    const slot = renderSlot(definition.threadLists[0]!, { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => { }, searchQuery: '' }, { sidebarThreads: { status: 'ready', projects: [{ id: 'p1', name: 'Example', isPersonal: false, href: '/projects/p1', settingsHref: '/settings/p1' }], threads: [], sections: [] }, rpc: { paths: () => [{ id: 'p1', name: 'Example', path: null }] } });
    fireEvent.click(slot.getByRole('tab',{name:'Проекты'}));
    const project = await slot.findByRole('button', { name: 'Example' });
    fireEvent.contextMenu(project);
    fireEvent.click(await slot.findByText('Скрыть'));
    await waitFor(() => expect(slot.queryByRole('button', { name: 'Example' })).toBeNull());
    fireEvent.click(slot.getByRole('button', { name: 'Показать скрытое' }));
    fireEvent.contextMenu(await slot.findByRole('button', { name: 'Example' }));
    fireEvent.click(await slot.findByText('Вернуть'));
    fireEvent.click(slot.getByRole('button', { name: 'Скрыть скрытое' }));
    expect(slot.getByRole('button', { name: 'Example' })).toBeTruthy();
    slot.lifecycle.unmount();
});

test('collapsed folders and projectless section keep only live threads visible', async () => {
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));

 // Complete synthetic sidebar rows; no backend or real workspace data.

 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{settings:{rootPath:'/Projects'},sidebarThreads:{status:'ready',projects:[{id:'p',name:'Example',isPersonal:false,href:'/p',settingsHref:'/s'},{id:'loose',name:'Personal',isPersonal:true,href:'/l',settingsHref:'/s'}],threads:[make('busy','p','active'),make('idle','p','idle'),make('loose-idle','loose','idle'),make('loose-busy','loose','active')],sections:[]},rpc:{paths:()=>[{id:'p',name:'Example',path:'/Projects/Personal/Example'}]}});
 const activeSection=within(slot.getByRole('region',{name:'Активные'}));
 expect(activeSection.getAllByRole('link',{name:/busy/}).length).toBe(2);
 expect(activeSection.queryByRole('link',{name:'idle'})).toBeNull();
 expect(slot.queryByRole('link',{name:'idle'})).toBeNull();
 expect(slot.queryByRole('link',{name:'loose-idle'})).toBeNull();
 fireEvent.click(slot.getByRole('tab',{name:'Проекты'}));
 await slot.findByRole('button',{name:'Personal 2'});
 fireEvent.click(slot.getByRole('button',{name:'Без проекта 2'}));
 expect(slot.getByRole('link',{name:/loose-idle/})).toBeTruthy();
 slot.lifecycle.unmount();
});

test('projects are separate, searchable and retain active threads in their project',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{sidebarThreads:{status:'ready',projects:[{id:'p',name:'Example',isPersonal:false,href:'/p',settingsHref:'/s'}],threads:[make('busy','p','active'),make('quiet','p','idle')],sections:[]},rpc:{paths:()=>[{id:'p',name:'Example',path:null}],attention:()=>({entries:[],incomplete:false}),progress:()=>({availability:'ready',entries:[],failedThreadIds:[]})}});
 expect(slot.queryByRole('button',{name:'Example 2'})).toBeNull();
 fireEvent.click(slot.getByRole('tab',{name:'Проекты'}));
 const project=await slot.findByRole('button',{name:'Example 2'});
 fireEvent.click(project);
 expect(slot.getByRole('link',{name:/busy/})).toBeTruthy();
 expect(slot.getByRole('link',{name:/quiet/})).toBeTruthy();
 fireEvent.change(slot.getByRole('textbox',{name:'Найти проект'}),{target:{value:'missing'}});
 expect(slot.getByText('Проекты не найдены')).toBeTruthy();
 fireEvent.click(slot.getByRole('tab',{name:'Сейчас'}));
 expect(slot.getByRole('region',{name:'Активные'})).toBeTruthy();
 slot.lifecycle.unmount();
});
test('attention includes host errors and pending questions and opens the correct thread',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{sidebarThreads:{status:'ready',projects:[],threads:[{...make('question','p','idle'),hasPendingInteraction:true},make('failed','p','error'),make('worker','p','active')],sections:[]},rpc:{paths:()=>[],attention:()=>({entries:[],incomplete:false}),progress:()=>({availability:'ready',entries:[],failedThreadIds:[]})}});
 const inbox=within(slot.getByRole('region',{name:'Требует внимания'}));
 expect(inbox.getAllByRole('link')).toHaveLength(2);
 fireEvent.click(inbox.getByRole('link',{name:/question/}));
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({method:'toThread',threadId:'question'});
 fireEvent.click(slot.getByRole('button',{name:'Внимание 2'}));
 expect(within(slot.getByRole('region',{name:'Активные'})).queryByRole('link',{name:/worker/})).toBeNull();
 slot.lifecycle.unmount();
});
test('optional navigation header handshake removes duplicate controls and restores fallback on detach',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{rpc:{paths:()=>[],attention:()=>({entries:[],incomplete:false})}});
 expect(slot.getByRole('tab',{name:'Сейчас'})).toBeTruthy();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:true}})));
 expect(slot.queryByRole('tablist')).toBeNull();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:select',{detail:{tab:'projects'}})));
 expect(slot.getByRole('textbox',{name:'Найти проект'})).toBeTruthy();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:false}})));
 expect(slot.getByRole('tab',{name:'Проекты'}).getAttribute('aria-selected')).toBe('true');
 slot.lifecycle.unmount();
});
