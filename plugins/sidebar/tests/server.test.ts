import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {expect,test} from 'vitest';
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
