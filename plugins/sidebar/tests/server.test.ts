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
