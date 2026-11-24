// @vitest-environment jsdom
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type {useSdk} from '@get-bb/plugin-sdk/app';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import app from '../app';
beforeEach(() => {
 Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  close(this: HTMLDialogElement) { this.removeAttribute('open'); },
 });
});
afterEach(() => { cleanup(); localStorage.clear(); });
 const make=(id:string,projectId:string,status:'active'|'idle'|'error')=>({id,projectId,status,title:id,titleFallback:null,parentThreadId:null,parentNotifications:"auto" as const,lifecycleOwnerThreadId:null,sourceThreadId:null,sectionId:null,originKind:null,originPluginId:null,providerId:"test",pinnedAt:null,archivedAt:null,createdAt:Date.now(),updatedAt:1,lastReadAt:null,hasPendingInteraction:false,isUnread:false,isPinned:false,pinSortKey:null,isArchived:false,displayTitle:id,href:'/projects/'+projectId+'/threads/'+id,environment:null,host:null,isHidden:false,indicator:'none' as const,indicatorLabel:null,runtimeStatus:status,queuedWork:'none' as const,activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:0},latestAttentionAt:100});
type Environment = Awaited<ReturnType<ReturnType<typeof useSdk>['environments']['list']>>[number];
const featureEnvironment = {id: 'worktree', projectId: 'atlas', isWorktree: true, status: 'ready',
 lifecycle: {phase: 'active'}, name: 'Feature', branchName: 'feature'} as Environment;
const mainStatus = (options: {dirty?: boolean; unmerged?: boolean; aheadCount?: number} = {}) => ({
 outcome: 'available',
 workspace: {
  workingTree: {fileCount: options.dirty ? 1 : 0, hasUncommittedChanges: false},
  branch: {currentBranch: 'feature'},
  mergeBase: {mergeBaseBranch: 'refs/heads/main', baseRef: 'main-head', aheadCount: options.aheadCount ?? 0,
   hasCommittedUnmergedChanges: options.unmerged ?? false, squashMergeCheckComplete: true},
 },
});
type ListedThread = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['list']>>[number];
function listedThread(id: string, extra: Partial<ListedThread> = {}): ListedThread {
 return {...make(id, 'atlas', 'idle'), deletedAt: null, visibility: 'visible', ...extra} as ListedThread;
}

async function catalogSlot(sdk?: NonNullable<Parameters<typeof renderSlot>[2]>['sdk']) {
 const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
 const projects = ['atlas', 'orbit', 'retired', 'unused', 'outside', 'personal'].map(id =>
  ({id, name: id, isPersonal: id === 'personal', href: '/projects/' + id, settingsHref: '/settings/' + id}));
 const slot = renderSlot(definition.threadLists[0]!, {
  activeThreadId: null, activeProjectId: 'atlas', isCompactViewport: false, onNavigate: () => {}, searchQuery: '',
 }, {
  sdk: {environments: {list: async () => []}, ...sdk},
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

test('archiving a project uses every page of unarchived threads, including hidden children', async () => {
 const visible = Array.from({length: 100}, (_, i) => listedThread('atlas-' + i));
 const hiddenChild = listedThread('child', {parentThreadId: 'atlas-0', visibility: 'hidden'});
 const archived = new Set<string>();
 const {slot} = await catalogSlot({threads: {
  list: async args => {
   expect(args).toMatchObject({projectId: 'atlas', archived: false, includeHidden: true, limit: 100});
   return [...visible, hiddenChild].filter(row => !archived.has(row.id))
    .slice(args?.offset ?? 0, (args?.offset ?? 0) + 100);
  },
  archive: async ({threadId}) => { archived.add(threadId); return {ok: true, archivedThreadIds: [threadId]}; },
 }});
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Архивировать все треды'}));
 expect(archived.size).toBe(0);
 const dialog = within(slot.getByRole('alertdialog'));
 fireEvent.click(dialog.getByRole('button', {name: 'Архивировать'}));
 await waitFor(() => expect(archived.size).toBe(101));
 expect(archived.has('child')).toBe(true);
 slot.lifecycle.unmount();
});

test('a partial archive failure reports the remaining work and can be retried', async () => {
 const rows = [listedThread('blocked'), listedThread('ready')];
 const archived = new Set<string>();
 let allowBlocked = false;
 const {slot} = await catalogSlot({threads: {
  list: async () => rows.filter(row => !archived.has(row.id)),
  archive: async ({threadId}) => {
   if (threadId === 'blocked' && !allowBlocked) throw new Error('BB rejected the request');
   archived.add(threadId);
   return {ok: true, archivedThreadIds: [threadId]};
  },
 }});
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Архивировать все треды'}));
 const dialog = within(slot.getByRole('alertdialog'));
 fireEvent.click(dialog.getByRole('button', {name: 'Архивировать'}));
 expect((await dialog.findByRole('alert')).textContent).toBe('Архивировано: 1. Не удалось архивировать: 1.');
 expect([...archived]).toEqual(['ready']);
 allowBlocked = true;
 fireEvent.click(dialog.getByRole('button', {name: 'Архивировать'}));
 await waitFor(() => expect(slot.queryByRole('alertdialog')).toBeNull());
 expect([...archived]).toEqual(['ready', 'blocked']);
 slot.lifecycle.unmount();
});

test('deleting a project calls BB for the selected project only after confirmation', async () => {
 const deleted: string[] = [];
 const {slot} = await catalogSlot({projects: {
  delete: async ({projectId}) => { deleted.push(projectId); return {ok: true}; },
 }});
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 const actions = await slot.findByRole('button', {name: 'Действия проекта orbit'});
 fireEvent.click(actions);
 fireEvent.click(slot.getByRole('button', {name: 'Удалить проект'}));
 fireEvent.click(within(slot.getByRole('alertdialog')).getByRole('button', {name: 'Отмена'}));
 expect(deleted).toEqual([]);
 fireEvent.click(actions);
 fireEvent.click(slot.getByRole('button', {name: 'Удалить проект'}));
 const dialog = within(slot.getByRole('alertdialog'));
 expect(dialog.getByText('orbit')).toBeTruthy();
 fireEvent.click(dialog.getByRole('button', {name: 'Удалить проект'}));
 await waitFor(() => expect(deleted).toEqual(['orbit']));
 slot.lifecycle.unmount();
});

test.each([
 ['Архивировать все треды', 'Архивировать'],
 ['Удалить проект', 'Удалить проект'],
])('%s offers an AI merge prompt for an unmerged worktree', async (label, confirmation) => {
 const affected: string[] = [];
 const {slot} = await catalogSlot({
  environments: {list: async () => [featureEnvironment]},
  plugins: {callRpc: async ({pluginId, method, input, outputSchema}) => {
   expect({pluginId, method, input}).toEqual({
    pluginId: 'bb--git', method: 'workspaceStatus', input: {environmentId: 'worktree', mergeBaseBranch: 'refs/heads/main'},
   });
   return outputSchema.parse(mainStatus({unmerged: true, aheadCount: 2}));
  }},
  threads: {list: async () => {affected.push('archive'); return [];}},
  projects: {delete: async () => {affected.push('delete'); return {ok: true};}},
 });
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: label}));
 const dialog = within(slot.getByRole('alertdialog'));
 fireEvent.click(dialog.getByRole('button', {name: confirmation}));
 const merge = await dialog.findByRole('button', {name: 'Подготовить слияние с ИИ'});
 expect(affected).toEqual([]);
 fireEvent.click(merge);
 expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
  method: 'toCompose', options: {projectId: 'atlas', environmentId: 'worktree', initialPrompt: expect.stringContaining('main')},
 });
 expect(affected).toEqual([]);
 slot.lifecycle.unmount();
});

test('archiving waits for an unavailable check, then allows a clean squash-merged worktree', async () => {
 let ready = false;
 const archived: string[] = [];
 const {slot} = await catalogSlot({
  environments: {list: async () => [featureEnvironment]},
  plugins: {callRpc: async ({outputSchema}) => outputSchema.parse(ready ? mainStatus({aheadCount: 2}) : {outcome: 'unavailable'})},
  threads: {list: async () => [listedThread('rest')], archive: async ({threadId}) => {
   archived.push(threadId); return {ok: true, archivedThreadIds: [threadId]};
  }},
 });
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Архивировать все треды'}));
 const dialog = within(slot.getByRole('alertdialog'));
 fireEvent.click(dialog.getByRole('button', {name: 'Архивировать'}));
 await dialog.findByText('Не удалось проверить относительно main.');
 expect(dialog.queryByRole('button', {name: 'Продолжить без слияния'})).toBeNull();
 expect(archived).toEqual([]);
 ready = true;
 fireEvent.click(dialog.getByRole('button', {name: 'Проверить и архивировать'}));
 await waitFor(() => expect(archived).toEqual(['rest']));
 slot.lifecycle.unmount();
});

test('deleting with untracked work requires an explicit second confirmation', async () => {
 const deleted: string[] = [];
 const {slot} = await catalogSlot({
  environments: {list: async () => [featureEnvironment]},
  plugins: {callRpc: async ({outputSchema}) => outputSchema.parse(mainStatus({dirty: true}))},
  projects: {delete: async ({projectId}) => {deleted.push(projectId); return {ok: true};}},
 });
 fireEvent.click(slot.getByRole('tab', {name: 'Проекты'}));
 fireEvent.click(await slot.findByRole('button', {name: 'Действия проекта atlas'}));
 fireEvent.click(slot.getByRole('button', {name: 'Удалить проект'}));
 const dialog = within(slot.getByRole('alertdialog'));
 fireEvent.click(dialog.getByRole('button', {name: 'Удалить проект'}));
 const proceed = await dialog.findByRole('button', {name: 'Продолжить без слияния'});
 expect(dialog.getByText('Незакоммиченные изменения')).toBeTruthy();
 expect(deleted).toEqual([]);
 fireEvent.click(proceed);
 await waitFor(() => expect(deleted).toEqual(['atlas']));
 slot.lifecycle.unmount();
});

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
 const loadActivity = vi.fn(() => ({days: Array.from({length: 14}, (_, index) => ({
  day: '2026-11-' + (index + 10), input: 100, output: 20, cached: 30, samples: 1, created: 2, archived: 1,
 }))}));
 const panel = renderSlot(definition.navPanels[0]!, {subPath: 'atlas'}, {
  sidebarThreads: {status: 'ready', projects, sections: [], threads: [
   make('running', 'atlas', 'active'),
   {...make('archived', 'atlas', 'idle'), isArchived: true},
   make('other', 'orbit', 'active'),
  ]},
  rpc: {project_activity: loadActivity, project_overview: () => ({
   capturedAt: 1760000000000,
   project: {id: 'atlas', name: 'atlas', kind: 'standard', gitRemoteUrl: null, createdAt: 1, updatedAt: 2,
    sources: [
     {id: 'source', type: 'local_path', path: '/Projects/Work/Team/atlas', isDefault: true, createdAt: 1, updatedAt: 2},
     {id: 'docs', type: 'local_path', path: '/Projects/Work/Team/docs', isDefault: false, createdAt: 3, updatedAt: 4},
    ]},
   groups: {unarchivedVisible: {parent: 1, child: 0}, unarchivedHidden: {parent: 0, child: 0},
    archivedVisible: {parent: 0, child: 0}, archivedHidden: {parent: 0, child: 0}},
   threads: [{id: 'thread-sample', title: 'Example', status: 'idle', visibility: 'visible',
    providerId: 'test', createdAt: 5, updatedAt: 6, hasPendingInteraction: false}],
  })},
 });
 expect(await panel.findByRole('heading', {name: 'atlas'})).toBeTruthy();
 const properties = within(panel.getByRole('region', {name: 'Свойства проекта'}));
 const tabs = within(properties.getByRole('tablist', {name: 'Разделы проекта'}));
 const overview = tabs.getByRole('tab', {name: 'Обзор'});
 const analytics = tabs.getByRole('tab', {name: 'Аналитика'});
 const sources = tabs.getByRole('tab', {name: 'Источники'});
 expect(overview.getAttribute('aria-selected')).toBe('true');
 const overviewContent = within(properties.getByRole('tabpanel', {name: 'Обзор'}));
 expect(overviewContent.getByRole('heading', {name: 'Распределение тредов'})).toBeTruthy();
 expect(overviewContent.getByRole('heading', {name: 'Архив и видимость'})).toBeTruthy();
 const distribution = within(overviewContent.getByRole('region', {name: 'Распределение тредов'}));
 expect(distribution.getAllByRole('listitem')).toHaveLength(3);
 const breakdown = within(overviewContent.getByRole('table', {name: 'Разбивка тредов'}));
 expect(breakdown.getAllByRole('row')).toHaveLength(5);
 expect(within(breakdown.getByRole('row', {name: 'Вне архива / видимые 1 0 1'})).getAllByRole('cell')
  .map(cell => cell.textContent)).toEqual(['1', '0', '1']);
 expect(overviewContent.getByText('Git remote URL')).toBeTruthy();
 expect(overviewContent.getByText('Снимок данных')).toBeTruthy();
 const json = properties.getByText('Фрагмент JSON').parentElement!.querySelector('pre')!;
 const overviewJson = json.textContent;
 expect(JSON.parse(overviewJson ?? '').threads).toEqual([{id: 'thread-sample', title: 'Example', status: 'idle',
  visibility: 'visible', providerId: 'test', createdAt: 5, updatedAt: 6, hasPendingInteraction: false}]);
 expect(loadActivity).not.toHaveBeenCalled();
 overview.focus();
 fireEvent.keyDown(overview, {key: 'End'});
 expect(document.activeElement).toBe(sources);
 expect(sources.getAttribute('aria-selected')).toBe('true');
 expect(properties.queryByRole('tabpanel', {name: 'Обзор'})).toBeNull();
 const sourceContent = within(properties.getByRole('tabpanel', {name: 'Источники'}));
 expect(sourceContent.getByText('/Projects/Work/Team/atlas')).toBeTruthy();
 expect(sourceContent.getByText('/Projects/Work/Team/docs')).toBeTruthy();
 expect(sourceContent.getAllByText('По умолчанию')).toHaveLength(2);
 expect(properties.getByText('Фрагмент JSON')).toBeTruthy();
 expect(loadActivity).not.toHaveBeenCalled();
 fireEvent.click(analytics);
 expect(await panel.findByRole('img', {name: 'Потребление токенов'})).toBeTruthy();
 expect(loadActivity).toHaveBeenCalledTimes(1);
 expect(panel.getByText('30%', {exact: true})).toBeTruthy();
 fireEvent.change(panel.getByRole('combobox', {name: 'Период'}), {target: {value: '14'}});
 expect(panel.getByRole('combobox', {name: 'День'}).querySelectorAll('option')).toHaveLength(14);
 fireEvent.click(panel.getByRole('button', {name: 'Активность'}));
 expect(panel.getByRole('img', {name: 'Активность тредов'})).toBeTruthy();
 expect(panel.queryByText('30%', {exact: true})).toBeNull();
 fireEvent.click(overview);
 expect(properties.queryByRole('img', {name: 'Активность тредов'})).toBeNull();
 fireEvent.click(analytics);
 expect(properties.getByRole('img', {name: 'Активность тредов'})).toBeTruthy();
 expect((properties.getByRole('combobox', {name: 'Период'}) as HTMLSelectElement).value).toBe('14');
 expect(loadActivity).toHaveBeenCalledTimes(1);
 expect(properties.getByText('Фрагмент JSON')).toBeTruthy();
 expect(json.textContent).toBe(overviewJson);
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
