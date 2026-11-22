// @vitest-environment jsdom
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {act,cleanup,render} from '@testing-library/react';
import {ProgressProvider,useThreadPlans,useObserveThreadPlans} from '../src/adapters/bb/progress-context';
const mock=vi.hoisted(()=>({call:vi.fn(),changed:null as null|(()=>void)}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>({call:mock.call}),useRealtime:(_name:string,callback:()=>void)=>{mock.changed=callback;}}));
function Probe(){const result=useThreadPlans('test');return <div>{result.plans.map(p=>p.title).join(',')}|{result.failed?'stale':'fresh'}</div>;}
const plan={id:'p',title:'Saved progress',state:'running',updatedAt:1,stages:[]};
let mode:'ok'|'error'|'partial'|'hang'='ok';
beforeEach(()=>{
 vi.useFakeTimers();mode='ok';
 mock.call.mockImplementation(async(name:string)=>{
  if(name==='attention')return {entries:[],incomplete:false};
  if(mode==='error')throw Error('offline');
  if(mode==='hang')return new Promise(()=>{});
  return {availability:'ready',entries:mode==='partial'?[]:[{threadId:'test',plans:[plan]}],failedThreadIds:mode==='partial'?['test']:[]};
 });
});
afterEach(()=>{cleanup();vi.useRealTimers();mock.call.mockReset();});
const flush=async(ms=0)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
test('transient and per-thread failures keep the last saved bar and automatically recover',async()=>{
 const slot=render(<ProgressProvider><Probe/></ProgressProvider>);await flush();
 expect(slot.container.textContent).toBe('Saved progress|fresh');
 mode='error';await flush(5000);expect(slot.container.textContent).toBe('Saved progress|stale');
 mode='partial';await flush(5000);expect(slot.container.textContent).toBe('Saved progress|stale');
 mode='ok';await flush(5000);expect(slot.container.textContent).toBe('Saved progress|fresh');
});
test('hung RPC times out and retries automatically',async()=>{
 const slot=render(<ProgressProvider><Probe/></ProgressProvider>);await flush();
 mode='hang';await flush(15000);expect(slot.container.textContent).toBe('Saved progress|stale');
 mode='ok';await flush(5000);expect(slot.container.textContent).toBe('Saved progress|fresh');
});
test('attention failures do not prevent progress loading; realtime retries without clearing bars',async()=>{
 const original=mock.call.getMockImplementation()!;
 mock.call.mockImplementation(async(name:string,...args:unknown[])=>{if(name==='attention')throw Error('index unavailable');return original(name,...args);});
 const slot=render(<ProgressProvider><Probe/></ProgressProvider>);await flush();
 expect(slot.container.textContent).toBe('Saved progress|fresh');
 mode='error';act(()=>mock.changed?.());await flush();expect(slot.container.textContent).toBe('Saved progress|stale');
 mode='ok';act(()=>mock.changed?.());await flush();expect(slot.container.textContent).toBe('Saved progress|fresh');
});

test('folded active descendants remain registered for recovery',async()=>{
 function Folded(){useObserveThreadPlans(['active-child']);return null;}
 render(<ProgressProvider><Folded/></ProgressProvider>);await flush();
 expect(mock.call).toHaveBeenCalledWith('progress',{threadIds:['active-child']});
});

test('a successful empty response clears a deliberately removed plan instead of reviving it',async()=>{
 const slot=render(<ProgressProvider><Probe/></ProgressProvider>);await flush();
 expect(slot.container.textContent).toBe('Saved progress|fresh');
 const original=mock.call.getMockImplementation()!;
 mock.call.mockImplementation(async(name:string,...args:unknown[])=>name==='progress'?{availability:'ready',entries:[{threadId:'test',plans:[]}],failedThreadIds:[]}:original(name,...args));
 act(()=>mock.changed?.());await flush();
 expect(slot.container.textContent).toBe('|fresh');
});

test('parent aggregate advances from child polling while the parent agent is idle and survives remount',async()=>{
 let done=false;
 mock.call.mockImplementation(async(name:string,input:{threadIds:string[]})=>name==='attention'?{entries:[],incomplete:false}:{availability:'ready',failedThreadIds:[],entries:input.threadIds.map(threadId=>({threadId,plans:threadId==='child'?[{...plan,stages:[{name:'Work',steps:[{title:'One',status:done?'done':'active'},{title:'Two',status:done?'done':'pending'}]}]}]:[]}))});
 function Parent(){const result=useThreadPlans('idle-parent',[{id:'child',parentThreadId:'idle-parent',title:'Child'}]);return <div>{result.plans[0]?.stages.flatMap(s=>s.steps).filter(s=>s.status==='done').length}</div>;}
 let slot=render(<ProgressProvider><Parent/></ProgressProvider>);await flush();
 expect(slot.container.textContent).toBe('0');done=true;await flush(5000);
 expect(slot.container.textContent).toBe('2');slot.unmount();
 slot=render(<ProgressProvider><Parent/></ProgressProvider>);await flush();expect(slot.container.textContent).toBe('2');
});
