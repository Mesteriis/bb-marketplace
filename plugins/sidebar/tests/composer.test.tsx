// @vitest-environment jsdom
import {afterEach,expect,test} from 'vitest';
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
import app from '../app';
import {applyOp,setVisibility,type Bar} from '../src/core/planning/engine';
afterEach(()=>{cleanup();localStorage.clear();});
function fixture(id:string):Bar {
 const result=applyOp([],{id,title:`Plan ${id}`,steps:[{title:'One'},{title:'Two'},{title:'Three'}]},100);
 if(!result.ok)throw Error(result.error);
 return result.bar;
}
test('the retained composer shows own plans and preserves folding across remount',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 const banner=definition.composerCustomizations[0]!.banners![0]!;
 let bars=[fixture('one'),fixture('two'),fixture('three'),fixture('four')];
 const mount=()=>renderSlot(banner,{}, {context:{threadId:'fixture-thread',projectId:null},settings:{autoClose:false,effects:false},rpc:{
  bars_get:()=>({bars}),agents_get:()=>({agents:[]}),approvals_get:()=>({count:0,incomplete:false}),diagnostics_get:()=>({diagnostic:{warning:null}}),
  bars_setVisibility:(input)=>{const {id,hidden,endedAt}=input as {id:string;hidden:boolean;endedAt?:number};bars=bars.map(b=>b.id===id?setVisibility(b,hidden,endedAt):b);return {changed:true};},
 }});
 let slot=mount();
 await slot.findByRole('button',{name:'Show all (4)'});
 expect(slot.getAllByRole('progressbar')).toHaveLength(3);
 expect(slot.container.querySelectorAll('.pp-track-head')).toHaveLength(3);
 fireEvent.click(slot.getByRole('button',{name:'Show all (4)'}));
 expect(slot.getAllByRole('progressbar')).toHaveLength(4);
 fireEvent.click(slot.getByRole('button',{name:/Progress · 4/}));
 expect(slot.queryAllByRole('progressbar')).toHaveLength(0);
 slot.lifecycle.unmount();
 slot=mount();
 await slot.findByRole('button',{name:/Progress · 4/});
 await waitFor(()=>expect(slot.queryAllByRole('progressbar')).toHaveLength(0));
 slot.lifecycle.unmount();
});
