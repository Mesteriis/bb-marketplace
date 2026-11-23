// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import app from '../app';
afterEach(() => { cleanup(); localStorage.clear(); });
 const make=(id:string,projectId:string,status:'active'|'idle'|'error')=>({id,projectId,status,title:id,titleFallback:null,parentThreadId:null,parentNotifications:"auto" as const,lifecycleOwnerThreadId:null,sourceThreadId:null,sectionId:null,originKind:null,originPluginId:null,providerId:"test",pinnedAt:null,archivedAt:null,createdAt:Date.now(),updatedAt:1,lastReadAt:null,hasPendingInteraction:false,isUnread:false,isPinned:false,pinSortKey:null,isArchived:false,displayTitle:id,href:'/projects/'+projectId+'/threads/'+id,environment:null,host:null,isHidden:false,indicator:'none' as const,indicatorLabel:null,runtimeStatus:status,queuedWork:'none' as const,activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:0},latestAttentionAt:100});
async function catalogSlot() {
 const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
 const projects = ['atlas', 'orbit', 'retired', 'unused', 'outside', 'personal'].map(id =>
  ({id, name: id, isPersonal: id === 'personal', href: '/projects/' + id, settingsHref: '/settings/' + id}));
 const slot = renderSlot(definition.threadLists[0]!, {
  activeThreadId: null, activeProjectId: 'atlas', isCompactViewport: false, onNavigate: () => {}, searchQuery: '',
 }, {
  settings: {rootPath: '/Projects'},
  sidebarThreads: {status: 'ready', projects, sections: [], threads: [
   {...make('active-thread', 'atlas', 'active'), latestAttentionAt: 400},
   {...make('recent-thread', 'orbit', 'idle'), latestAttentionAt: 500, isUnread: true},
   {...make('old-thread', 'retired', 'idle'), isArchived: true},
   {...make('archived-atlas-thread', 'atlas', 'idle'), isArchived: true},
   {...make('child-atlas-thread', 'atlas', 'idle'), parentThreadId: 'active-thread'},
   {...make('child-with-archived-parent', 'atlas', 'idle'), parentThreadId: 'archived-atlas-thread'},
   {...make('projectless-thread', 'personal', 'idle'), createdAt: 1},
   {...make('projectless-child', 'personal', 'idle'), parentThreadId: 'projectless-thread'},
   make('outside-thread', 'outside', 'active'),
  ]},
  rpc: {paths: () => projects.map(({id, name}) => ({
   id, name, path: id === 'outside' ? '/Projects-old/outside'
    : '/Projects/' + (id === 'orbit' ? 'Personal' : 'Work/Team') + '/' + id,
  })), attention: () => ({entries: [], incomplete: false})},
 });
 return {slot, definition, projects};
}

test('manual hiding applies to running projects and can be reversed from visibility settings', async () => {
 const {slot} = await catalogSlot();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 await slot.findByRole('button', {name: /^atlas/});
 fireEvent.click(slot.getByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Скрыть проект'}));
 expect(slot.queryByRole('button', {name: /^atlas/})).toBeNull();
 fireEvent.click(slot.getByRole('button', {name: 'Видимость проектов'}));
 fireEvent.click(slot.getByRole('checkbox', {name: 'Показывать скрытые'}));
 expect(slot.getByRole('button', {name: /^atlas/})).toBeTruthy();
 fireEvent.click(slot.getByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Вернуть в список'}));
 expect(slot.getByRole('button', {name: /^atlas/})).toBeTruthy();
 expect(localStorage.getItem('makosh-sidebar:hidden:v1')).toBe('{"projects":[],"threads":[],"catalogProjects":[]}');
 slot.lifecycle.unmount();
});

test('the catalog hides archive-only and unused projects until requested', async () => {
 const {slot} = await catalogSlot();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 await slot.findByRole('button', {name: /^atlas/});
 expect(slot.queryByRole('button', {name: /retired|unused|outside/})).toBeNull();
 fireEvent.click(slot.getByRole('button', {name: 'Видимость проектов'}));
 fireEvent.click(slot.getByRole('checkbox', {name: 'Показывать пустые'}));
 expect(slot.getByRole('button', {name: /^retired/})).toBeTruthy();
 expect(slot.getByRole('button', {name: /^unused/})).toBeTruthy();
 expect(slot.queryByRole('button', {name: /outside/})).toBeNull();
 slot.lifecycle.unmount();
});

test('the catalog filters by folder, sorts and searches by path', async () => {
 const {slot} = await catalogSlot();
 expect(slot.getByRole('region', {name: 'Треды за последние 24 часа'})).toBeTruthy();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 await slot.findByRole('button', {name: /^atlas/});
 const list = within(slot.getByRole('list', {name: 'Проекты'}));
 const projectsInOrder = () => list.getAllByRole('button', {name: /^(atlas|orbit)/})
  .map(button => button.textContent?.match(/^(atlas|orbit)/)?.[0]);
 expect(projectsInOrder()).toEqual(['orbit', 'atlas']);
 fireEvent.change(slot.getByRole('combobox', {name: 'Сортировка проектов'}), {target: {value: 'name'}});
 expect(projectsInOrder()).toEqual(['atlas', 'orbit']);
 fireEvent.click(slot.getByRole('button', {name: 'Work'}));
 expect(slot.queryByRole('button', {name: /^orbit/})).toBeNull();
 fireEvent.change(slot.getByRole('textbox', {name: 'Найти проект'}), {target: {value: 'work/team'}});
 expect(slot.getByRole('button', {name: /^atlas/})).toBeTruthy();
 fireEvent.click(slot.getByRole('tab', {name: 'Сегодня'}));
 expect(slot.getByRole('region', {name: 'Треды за последние 24 часа'})).toBeTruthy();
 slot.lifecycle.unmount();
});

test('opening a project shows its overview and closes the previous project list', async () => {
 const {slot} = await catalogSlot();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 const first = await slot.findByRole('button', {name: /^atlas/, expanded: false});
 fireEvent.click(first);
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
  method: 'toPluginPanel', path: 'project-info', options: {subPath: 'atlas'},
 });
 const atlas = within(slot.getByRole('list', {name: 'Треды проекта atlas'}));
 expect(atlas.queryByText('archived-atlas-thread')).toBeNull();
 expect(atlas.queryByText('child-atlas-thread')).toBeNull();
 expect(atlas.queryByText('child-with-archived-parent')).toBeNull();
 expect(atlas.getByRole('img', {name: 'В работе'})).toBeTruthy();
 fireEvent.click(atlas.getByRole('link', {name: 'active-thread В работе'}));
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({method:'toThread', threadId:'active-thread'});
 const second = slot.getByRole('button', {name: /^orbit/, expanded: false});
 fireEvent.click(second);
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
  method: 'toPluginPanel', path: 'project-info', options: {subPath: 'orbit'},
 });
 expect(slot.queryByRole('list', {name: 'Треды проекта atlas'})).toBeNull();
 const orbit = within(slot.getByRole('list', {name: 'Треды проекта orbit'}));
 fireEvent.click(orbit.getByRole('button', {name: 'Открыть рядом: recent-thread'}));
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({method:'toThread', threadId:'recent-thread', options:{split:true}});
 const navigations = slot.inspection.navigateCalls.length;
 fireEvent.click(second);
 expect(slot.queryByRole('list', {name: 'Треды проекта orbit'})).toBeNull();
 expect(slot.inspection.navigateCalls).toHaveLength(navigations);
 slot.lifecycle.unmount();
});

test('projectless conversations open in the sidebar outside the scoped catalog', async () => {
 const {slot} = await catalogSlot();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: /^atlas/, expanded: false}));
 const navigations = slot.inspection.navigateCalls.length;
 fireEvent.click(slot.getByRole('button', {name: 'Без проекта', expanded: false}));
 expect(slot.queryByRole('list', {name: 'Треды проекта atlas'})).toBeNull();
 expect(slot.inspection.navigateCalls).toHaveLength(navigations);
 const list = within(slot.getByRole('list', {name: 'Треды без проекта'}));
 expect(list.queryByText('active-thread')).toBeNull();
 expect(list.queryByText('projectless-child')).toBeNull();
 expect(list.queryByRole('img')).toBeNull();
 expect(list.queryByText('Нет активности')).toBeNull();
 fireEvent.click(list.getByRole('link', {name: 'projectless-thread'}));
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({method: 'toThread', threadId: 'projectless-thread'});
 slot.lifecycle.unmount();
});
test('the project menu groups actions and opens properties without expanding the project', async () => {
 const {slot, definition, projects} = await catalogSlot();
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 const card = await slot.findByRole('button', {name: /^atlas/, expanded: false});
 expect(slot.queryByRole('link', {name: /Свойства проекта/})).toBeNull();
 const actions = slot.getByRole('button', {name: 'Действия проекта atlas'});
 fireEvent.click(actions);
 const menu = within(slot.getByRole('group', {name: 'Действия проекта atlas'}));
 expect(menu.getByRole('button', {name: 'Новый тред'})).toBeTruthy();
 expect(menu.getByRole('button', {name: 'Скрыть проект'})).toBeTruthy();
 expect(within(card).getByRole('img', {name: '1 в работе'})).toBeTruthy();
 const info = menu.getByRole('link', {name: 'Свойства проекта'});
 expect(info.getAttribute('href')).toBe('/plugins/makosh-sidebar/project-info/atlas');
 fireEvent.click(info);
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
  method: 'toPluginPanel', path: 'project-info', options: {subPath: 'atlas'},
 });
 expect(card.getAttribute('aria-expanded')).toBe('false');
 expect(actions.getAttribute('aria-expanded')).toBe('false');
 const panel = renderSlot(definition.navPanels[0]!, {subPath: 'atlas'}, {
  sidebarThreads: {status: 'ready', projects, sections: [], threads: [
   make('running', 'atlas', 'active'),
   {...make('archived', 'atlas', 'idle'), isArchived: true},
   make('other', 'orbit', 'active'),
  ]},
  rpc: {project_overview: () => ({
   capturedAt: 1760000000000,
   project: {id: 'atlas', name: 'atlas', kind: 'standard', gitRemoteUrl: null, createdAt: 1, updatedAt: 2,
    sources: [{id: 'source', type: 'local_path', path: '/Projects/Work/Team/atlas', isDefault: true, createdAt: 1, updatedAt: 2}]},
   groups: {unarchivedVisible: {parent: 1, child: 0}, unarchivedHidden: {parent: 0, child: 0},
    archivedVisible: {parent: 0, child: 0}, archivedHidden: {parent: 0, child: 0}},
   threads: [],
  })},
 });
 expect(await panel.findByRole('heading', {name: 'atlas'})).toBeTruthy();
 expect(panel.getByText('/Projects/Work/Team/atlas')).toBeTruthy();
 expect(panel.getByRole('heading', {name: 'Распределение тредов'})).toBeTruthy();
 expect(panel.getByText('Фрагмент JSON')).toBeTruthy();
 expect(within(panel.getByRole('region', {name: 'Обзор проекта'})).queryByRole('textbox')).toBeNull();
 panel.lifecycle.unmount();
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
 expect(within(slot.getByRole('region',{name:'Треды за последние 24 часа'})).queryByRole('link',{name:/worker/})).toBeNull();
 slot.lifecycle.unmount();
});
test('optional navigation header handshake removes duplicate controls and restores fallback on detach',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 const slot=renderSlot(definition.threadLists[0]!,{activeThreadId:null,activeProjectId:null,isCompactViewport:false,onNavigate:()=>{},searchQuery:''},{rpc:{paths:()=>[],attention:()=>({entries:[],incomplete:false})}});
 expect(slot.getByRole('tab',{name:'Сегодня'})).toBeTruthy();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:true}})));
 expect(slot.queryByRole('tablist')).toBeNull();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:select',{detail:{tab:'projects'}})));
 expect(slot.getByRole('textbox',{name:'Найти проект'})).toBeTruthy();
 act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:false}})));
 expect(slot.getByRole('tab',{name:'Проекты'}).getAttribute('aria-selected')).toBe('true');
 slot.lifecycle.unmount();
});

test('the thread list shows the active plan on its thread row', async () => {
 const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
 const thread = make('busy', 'p', 'active');
 const slot = renderSlot(definition.threadLists[0]!, {
  activeThreadId: thread.id, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: '',
 }, {
  sidebarThreads: { status: 'ready', projects: [], threads: [thread], sections: [] },
  rpc: {
   paths: () => [],
   attention: () => ({ entries: [], incomplete: false }),
   bars_get: () => ({ bars: [] }),
   agents_get: () => ({ agents: [] }),
   progress: () => ({
    availability: 'ready',
    entries: [{ threadId: thread.id, plans: [{ id: 'plan', title: 'Sidebar fixture', state: 'running', updatedAt: 1, stages: [] }] }],
    failedThreadIds: [],
   }),
  },
 });
 const active = within(slot.getByRole('region', { name: 'Треды за последние 24 часа' }));
 expect(await active.findAllByRole('progressbar', { name: 'Sidebar fixture: В работе' })).not.toHaveLength(0);
 slot.lifecycle.unmount();
});

test('Сегодня retains older ancestors only while they have a recent descendant', async () => {
 vi.useFakeTimers({ now: 1732147200000 });
 try {
  const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
  const old = { ...make('old-parent', 'p', 'error'), createdAt: 1732060799999 };
  const edge = { ...make('exactly-24-hours', 'p', 'idle'), createdAt: 1732060800000, parentThreadId: old.id };
  const olderSibling = { ...make('older-sibling', 'p', 'active'), createdAt: 1732060799999, parentThreadId: old.id };
  const recent = { ...make('recent-idle', 'p', 'idle'), createdAt: 1732147199999 };
  const slot = renderSlot(definition.threadLists[0]!, {
   activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: '',
  }, {
   sidebarThreads: { status: 'ready', projects: [], threads: [old, edge, olderSibling, recent], sections: [] },
   rpc: { paths: () => [], attention: () => ({ entries: [], incomplete: false }), progress: () => ({ availability: 'ready', entries: [], failedThreadIds: [] }) },
  });
  expect(slot.getByRole('tab', { name: 'Сегодня' })).toBeTruthy();
  expect(slot.getByRole('link', { name: /old-parent/ })).toBeTruthy();
  expect(slot.queryByRole('link', { name: /exactly-24-hours/ })).toBeNull();
  fireEvent.click(slot.getByRole('button', { name: 'Развернуть сабтреды: old-parent' }));
  expect(slot.getByRole('link', { name: /exactly-24-hours/ })).toBeTruthy();
  expect(slot.queryByRole('link', { name: /older-sibling/ })).toBeNull();
  expect(slot.getByRole('link', { name: /recent-idle/ })).toBeTruthy();
  expect(slot.queryByRole('region', { name: 'Требует внимания' })).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(slot.queryByRole('link', { name: /old-parent/ })).toBeNull();
  expect(slot.queryByRole('link', { name: /exactly-24-hours/ })).toBeNull();
  expect(slot.getByRole('link', { name: /recent-idle/ })).toBeTruthy();
  slot.lifecycle.unmount();
 } finally {
  vi.useRealTimers();
 }
});

test('idle threads keep plans behind disclosure and leave blockers visible', async () => {
 const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
 const finished = { ...make('finished', 'p', 'idle'), isUnread: true };
 const blocked = make('blocked', 'p', 'idle');
 const failed = make('failed-plan', 'p', 'idle');
 const plans = [
  { id: 'unfinished', title: 'Delivery plan', state: 'running', updatedAt: 1, stages: [{ name: 'Delivery', steps: [{ title: 'Merge the change', status: 'pending' }] }] },
  { id: 'blocked', title: 'Blocked plan', state: 'needs_input', updatedAt: 1, note: 'Choose the target branch', stages: [] },
  { id: 'failed', title: 'Failed plan', state: 'error', updatedAt: 1, note: 'Build failed', stages: [] },
 ];
 const threads = [finished, blocked, failed];
 const slot = renderSlot(definition.threadLists[0]!, {
  activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: '',
 }, {
  sidebarThreads: { status: 'ready', projects: [], threads, sections: [] },
  rpc: {
   paths: () => [],
   attention: () => ({ entries: [], incomplete: false }),
   progress: () => ({
    availability: 'ready',
    entries: threads.map((thread, index) => ({ threadId: thread.id, plans: [plans[index]] })),
    failedThreadIds: [],
   }),
  },
 });
 const today = within(slot.getByRole('region', { name: 'Треды за последние 24 часа' }));
 const toggle = await today.findByRole('button', { name: 'План: finished' });
 expect(today.getByText('Новый ответ')).toBeTruthy();
 expect(today.getByText('Choose the target branch')).toBeTruthy();
 expect(today.getByText('Build failed')).toBeTruthy();
 expect(today.queryByRole('progressbar')).toBeNull();
 expect(today.queryByText('Merge the change')).toBeNull();
 expect(today.queryByText(/^Обновлён/)).toBeNull();
 fireEvent.click(toggle);
 expect(today.getByText('Merge the change')).toBeTruthy();
 expect(today.getByText(/^Обновлён/)).toBeTruthy();
 expect(today.queryByRole('progressbar')).toBeNull();
 slot.lifecycle.unmount();
});
