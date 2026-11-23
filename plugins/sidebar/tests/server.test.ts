import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {expect,test,vi} from 'vitest';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import plugin from '../server';

const bar={id:'plan',title:'Synthetic plan',kind:'plan',state:'running',createdAt:1,updatedAt:2,stages:[{name:'Check',steps:[{title:'One',status:'active'}]}]};
test('own plans are available without another installed plugin; migration never overwrites',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'makosh-sidebar'});
 try {
  await plugin(bb);
  const payload={entries:[{key:'bars:thread-test',value:[bar]}]};
  expect(await harness.behavior.callRpc('progress_import',payload)).toEqual({imported:1,unchanged:0,conflicts:[]});
  expect(await harness.behavior.callRpc('progress_import',payload)).toEqual({imported:0,unchanged:1,conflicts:[]});
  expect(await harness.behavior.callRpc('progress_import',{entries:[{key:'bars:thread-test',value:[{...bar,title:'Other'}]}]})).toEqual({imported:0,unchanged:0,conflicts:['bars:thread-test']});
  const progress=await harness.behavior.callRpc('progress',{threadIds:['thread-test','thread-test','empty']}) as {entries:{threadId:string;plans:unknown[]}[]};
  expect(progress.entries.map(e=>[e.threadId,e.plans.length])).toEqual([['thread-test',1],['empty',0]]);
  expect(harness.inspection.sdk.callsTo('plugins.callRpc')).toHaveLength(0);
  expect(await harness.behavior.callRpc('progress_export',{keys:['bars:thread-test']})).toEqual(payload);
  await harness.behavior.callRpc('progress_import',{entries:[{key:'bars:waiting',value:[{...bar,state:'needs_input'}]}]});
  expect(await harness.behavior.callRpc('attention',null)).toEqual({entries:[{threadId:'waiting',state:'needs_input'}],incomplete:false});
  await harness.behavior.callRpc('bars_setVisibility',{threadId:'waiting',id:'plan',hidden:true});
  expect(await harness.behavior.callRpc('attention',null)).toEqual({entries:[],incomplete:false});
  await harness.lifecycle.reload(plugin);
  expect(await harness.behavior.callRpc('attention',null)).toEqual({entries:[],incomplete:false});
 } finally {await harness.lifecycle.dispose();}
});

test('sidebar RPC restores auto-hidden history and preserves timing across reload',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'makosh-sidebar'});let current=harness;
 try {
  await plugin(bb);
  const timed={...bar,state:'done',hidden:'auto',endedAt:20,stages:[{name:'First',steps:[{title:'One',status:'done',startedAt:1,endedAt:20}]}]};
  await harness.behavior.callRpc('progress_import',{entries:[{key:'bars:history-test',value:[timed]}]});
  current=(await harness.lifecycle.reload(plugin)).harness;
  const result=await current.behavior.callRpc('progress',{threadIds:['history-test']}) as {entries:{plans:unknown[]}[]};
  expect(result.entries[0]?.plans[0]).toMatchObject({createdAt:1,endedAt:20,hidden:'auto',stages:[{steps:[{startedAt:1,endedAt:20}]}]});
 } finally {await current.lifecycle.dispose();}
});

test('project overview reads all pages and keeps hidden thread titles out of the sample', async () => {
 const thread = (id: string, archivedAt: number | null, visibility: 'hidden' | 'visible', parentThreadId: string | null) =>
  ({id, projectId: 'project', archivedAt, visibility, parentThreadId, title: id, titleFallback: null,
    status: 'idle', providerId: 'test', createdAt: 1.25, updatedAt: 2.75, latestAttentionAt: 2, hasPendingInteraction: false});
 const active = [
  thread('visible-parent', null, 'visible', null),
  thread('visible-child', null, 'visible', 'visible-parent'),
  ...Array.from({length: 201}, (_, index) => thread('hidden-' + index, null, 'hidden', 'visible-parent')),
 ];
 const archived = [thread('archived-parent', 3, 'visible', null), thread('archived-hidden', 3, 'hidden', null)];
 const {bb, harness} = createFakePluginHost({pluginId: 'makosh-sidebar', sdk: {
  projects: {get: async () => ({id: 'project', name: 'Example', kind: 'standard', gitRemoteUrl: null, sources: [], createdAt: 1.5, updatedAt: 2})},
  threads: {list: async ({archived: inArchive, offset = 0, limit = 100} = {}) =>
   (inArchive ? archived : active).slice(offset, offset + limit) as Awaited<ReturnType<BbPluginApi['sdk']['threads']['list']>>},
 }});
 try {
  await plugin(bb);
  const result = await harness.behavior.callRpc('project_overview', {projectId: 'project'});
  expect(result).toMatchObject({
   project: {id: 'project', name: 'Example', createdAt: 1.5},
   groups: {unarchivedVisible: {parent: 1, child: 1}, unarchivedHidden: {parent: 0, child: 201},
    archivedVisible: {parent: 1, child: 0}, archivedHidden: {parent: 1, child: 0}},
   threads: [{id: 'visible-parent', updatedAt: 2.75}, {id: 'visible-child'}],
  });
  expect(JSON.stringify(result)).not.toContain('hidden-0');
 } finally {await harness.lifecycle.dispose();}
});

test('project activity counts recent archived and active threads and their daily token deltas', async () => {
 const now = Date.UTC(2026, 10, 23, 12);
 const yesterday = Date.UTC(2026, 10, 22, 12);
 const thread = (id: string, archivedAt: number | null) =>
  ({id, projectId: 'project', archivedAt, createdAt: yesterday});
 const event = (seq: number, createdAt: number, last: object) =>
  ({id: 'event-' + seq, seq, createdAt, type: 'thread/tokenUsage/updated',
    data: {tokenUsage: {total: {totalTokens: 9999}, last}}});
 const tokenCursors: (string | undefined)[] = [];
 const {bb, harness} = createFakePluginHost({pluginId: 'makosh-sidebar', sdk: {
  projects: {get: async () => ({id: 'project', name: 'Example', kind: 'standard', gitRemoteUrl: null, sources: [], createdAt: 1, updatedAt: 2})},
  threads: {
   list: async ({archived} = {}) => [archived ? thread('archived', now) : thread('active', null)] as
    Awaited<ReturnType<BbPluginApi['sdk']['threads']['list']>>,
   events: {list: async ({threadId, beforeSeq, order}) => {
    expect(order).toBe('desc');
    const rows = threadId === 'archived'
     ? [event(1, yesterday, {totalTokens: 75, outputTokens: 15, cacheReadInputTokens: 45})]
     : beforeSeq === undefined
      ? Array.from({length: 100}, (_, index) => event(102 - index, now, {}))
      : [event(2, now, {totalTokens: 120, outputTokens: 20, cachedInputTokens: 33}),
         event(1, Date.UTC(2026, 10, 8), {totalTokens: 400, outputTokens: 40})];
    if (threadId === 'active') tokenCursors.push(beforeSeq);
    return rows as Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>;
   }},
  },
 }});
 const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
 try {
  await plugin(bb);
  const result = await harness.behavior.callRpc('project_activity', {projectId: 'project'}) as {days: unknown[]};
  expect(result.days).toHaveLength(14);
  expect(tokenCursors).toEqual([undefined, '3']);
  expect(result.days.slice(-3)).toEqual([
   {day: '2026-11-21', created: 0, archived: 0, input: 0, output: 0, cached: 0, samples: 0},
   {day: '2026-11-22', created: 2, archived: 0, input: 60, output: 15, cached: 45, samples: 1},
   {day: '2026-11-23', created: 0, archived: 1, input: 100, output: 20, cached: 33, samples: 1},
  ]);
 } finally {
  dateNow.mockRestore();
  await harness.lifecycle.dispose();
 }
});
