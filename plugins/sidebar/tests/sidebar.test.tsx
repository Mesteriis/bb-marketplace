// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { fireEvent, cleanup, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import app from '../app';
afterEach(() => { cleanup(); localStorage.clear(); });
test('hidden project disappears, is revealed by the top toggle and can be restored', async () => {
    const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
    const slot = renderSlot(definition.threadLists[0]!, { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => { }, searchQuery: '' }, { sidebarThreads: { status: 'ready', projects: [{ id: 'p1', name: 'Example', isPersonal: false, href: '/projects/p1', settingsHref: '/settings/p1' }], threads: [], sections: [] }, rpc: { paths: () => [{ id: 'p1', name: 'Example', path: null }] } });
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
 const make=(id:string,projectId:string,status:'active'|'idle')=>({id,projectId,status,title:id,titleFallback:null,parentThreadId:null,parentNotifications:"auto" as const,lifecycleOwnerThreadId:null,sourceThreadId:null,sectionId:null,originKind:null,originPluginId:null,providerId:"test",pinnedAt:null,archivedAt:null,createdAt:1,updatedAt:1,lastReadAt:null,hasPendingInteraction:false,isUnread:false,isPinned:false,pinSortKey:null,isArchived:false,displayTitle:id,href:'/projects/'+projectId+'/threads/'+id,environment:null,host:null,isHidden:false,indicator:'none' as const,indicatorLabel:null,runtimeStatus:status,queuedWork:'none' as const,activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:0},latestAttentionAt:100});
 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{settings:{rootPath:'/Projects'},sidebarThreads:{status:'ready',projects:[{id:'p',name:'Example',isPersonal:false,href:'/p',settingsHref:'/s'},{id:'loose',name:'Personal',isPersonal:true,href:'/l',settingsHref:'/s'}],threads:[make('busy','p','active'),make('idle','p','idle'),make('loose-idle','loose','idle'),make('loose-busy','loose','active')],sections:[]},rpc:{paths:()=>[{id:'p',name:'Example',path:'/Projects/Personal/Example'}]}});
 await slot.findByRole('button',{name:'Personal 2'});
 expect(slot.getAllByRole('link',{name:/busy/}).length).toBe(2);
 expect(slot.queryByRole('link',{name:'idle'})).toBeNull();
 expect(slot.queryByRole('link',{name:'loose-idle'})).toBeNull();
 fireEvent.click(slot.getByRole('button',{name:'Без проекта 2'}));
 expect(slot.getByRole('link',{name:/loose-idle/})).toBeTruthy();
 slot.lifecycle.unmount();
});
